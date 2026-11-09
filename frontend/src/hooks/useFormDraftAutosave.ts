import { useCallback, useEffect, useRef, useState } from "react";
import { documentsAPI, templatesAPI } from "@/services/api";
import { collectFormAttachments } from "@/components/templates/formAttachments";

type Values = Record<string, unknown>;
type AutosaveStatus = "idle" | "unsaved" | "saving" | "saved" | "error";
type CachedUpload = { file: File; descriptor: Record<string, unknown> };

type Options = {
  enabled: boolean;
  dirty: boolean;
  templateId?: string | null;
  existingDocumentId?: string | null;
  documentTypeId?: string;
  title: string;
  values: Values;
  requisitionSubmission?: boolean;
  onCreated?: (id: string) => void;
  onSaved?: () => void;
};

function writeAttachmentValue(values: Values, field: string, descriptor: Record<string, unknown>) {
  if (field.startsWith("attachment_")) {
    values[field.slice("attachment_".length)] = descriptor;
    return;
  }
  if (!field.startsWith("tableattachment_")) return;
  const parts = field.slice("tableattachment_".length).split("~");
  if (parts.length < 3) return;
  const [tableKey, rowIndexText, ...columnParts] = parts;
  const rowIndex = Number(rowIndexText);
  const columnKey = columnParts.join("~");
  const rows = values[tableKey];
  if (!Array.isArray(rows) || !Number.isInteger(rowIndex) || !columnKey) return;
  const row = rows[rowIndex];
  if (row && typeof row === "object") {
    rows[rowIndex] = { ...(row as Record<string, unknown>), [columnKey]: descriptor };
  }
}

function readAttachmentValue(values: Values, field: string): unknown {
  if (field.startsWith("attachment_")) return values[field.slice("attachment_".length)];
  if (!field.startsWith("tableattachment_")) return undefined;
  const parts = field.slice("tableattachment_".length).split("~");
  if (parts.length < 3) return undefined;
  const [tableKey, rowIndexText, ...columnParts] = parts;
  const row = (values[tableKey] as unknown[] | undefined)?.[Number(rowIndexText)];
  return row && typeof row === "object" ? (row as Record<string, unknown>)[columnParts.join("~")] : undefined;
}

function isStoredAttachment(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && "storage_path" in value);
}

function prepareValues(values: Values, uploads: Map<string, CachedUpload>) {
  const { jsonValues, attachments } = collectFormAttachments(values);
  const pendingAttachments = attachments.filter(({ field, file }) => {
    const cached = uploads.get(field);
    if (!cached || cached.file !== file) return true;
    writeAttachmentValue(jsonValues, field, cached.descriptor);
    return false;
  });
  return { jsonValues, pendingAttachments };
}

export function useFormDraftAutosave({
  enabled, dirty, templateId, existingDocumentId, documentTypeId, title, values, requisitionSubmission = false, onCreated, onSaved,
}: Options) {
  const [documentId, setDocumentId] = useState<string | null>(existingDocumentId ?? null);
  const [status, setStatus] = useState<AutosaveStatus>(existingDocumentId ? "saved" : "idle");
  const latestRef = useRef({ templateId, existingDocumentId, documentTypeId, title, values, requisitionSubmission, onCreated, onSaved, dirty });
  latestRef.current = { templateId, existingDocumentId, documentTypeId, title, values, requisitionSubmission, onCreated, onSaved, dirty };
  const documentIdRef = useRef<string | null>(existingDocumentId ?? null);
  const versionsRef = useRef({ current: 0, saved: 0 });
  const inFlightRef = useRef<Promise<string | null> | null>(null);
  const discardingRef = useRef(false);
  const uploadsRef = useRef(new Map<string, CachedUpload>());
  const identityRef = useRef(`${templateId ?? ""}:${existingDocumentId ?? ""}`);

  useEffect(() => {
    const identity = `${templateId ?? ""}:${existingDocumentId ?? ""}`;
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    documentIdRef.current = existingDocumentId ?? null;
    setDocumentId(existingDocumentId ?? null);
    setStatus(existingDocumentId ? "saved" : "idle");
    versionsRef.current = { current: 0, saved: 0 };
    uploadsRef.current.clear();
  }, [templateId, existingDocumentId]);

  const saveNow = useCallback(async (force = false): Promise<string | null> => {
    if (discardingRef.current) return documentIdRef.current;
    const current = latestRef.current;
    if (!enabled || !current.templateId) return null;
    if (force && versionsRef.current.current <= versionsRef.current.saved) {
      versionsRef.current.current = versionsRef.current.saved + 1;
    }
    if (inFlightRef.current) {
      await inFlightRef.current;
      if (versionsRef.current.saved < versionsRef.current.current) return saveNow(false);
      return documentIdRef.current;
    }
    if (versionsRef.current.saved >= versionsRef.current.current) return documentIdRef.current;

    const run = async (): Promise<string | null> => {
      while (versionsRef.current.saved < versionsRef.current.current) {
        const version = versionsRef.current.current;
        const snapshot = latestRef.current;
        const { jsonValues, pendingAttachments } = prepareValues(snapshot.values, uploadsRef.current);
        const safeTitle = snapshot.title.trim() || "Untitled form";
        setStatus("saving");

        let savedId = documentIdRef.current;
        let response: any;
        if (!savedId) {
          const created = await templatesAPI.fillTemplateWithAttachments({
            template_id: snapshot.templateId!,
            values: jsonValues,
            output_format: "pdf",
            title: safeTitle,
            document_type_id: snapshot.documentTypeId,
            draft_from_template: true,
            ...(snapshot.requisitionSubmission ? { requisition_submission: true } : {}),
            attachments: pendingAttachments,
          });
          savedId = String(created.data?.document_id || created.data?.id || "") || null;
          if (!savedId) throw new Error("The server did not return the saved draft ID.");
          documentIdRef.current = savedId;
          setDocumentId(savedId);
          response = await documentsAPI.get(savedId);
          snapshot.onCreated?.(savedId);
        } else {
          response = await documentsAPI.updateForm(savedId, jsonValues, pendingAttachments, { autosave: true, title: safeTitle });
        }

        const serverValues = response?.data?.metadata?.form?.values;
        if (serverValues && typeof serverValues === "object") {
          for (const { field, file } of pendingAttachments) {
            const descriptor = readAttachmentValue(serverValues, field);
            if (isStoredAttachment(descriptor)) uploadsRef.current.set(field, { file, descriptor });
          }
        }
        versionsRef.current.saved = version;
      }
      setStatus("saved");
      latestRef.current.onSaved?.();
      return documentIdRef.current;
    };

    const pending = run();
    inFlightRef.current = pending;
    try {
      return await pending;
    } catch (error) {
      setStatus("error");
      throw error;
    } finally {
      inFlightRef.current = null;
    }
  }, [enabled]);

  // Explicit Save/Submit actions finalize the draft so the official PDF and
  // document version match the latest autosaved values. Cached file descriptors
  // prevent re-uploading attachments already persisted by a background save.
  const finalizeNow = useCallback(async (): Promise<string | null> => {
    const savedId = await saveNow(true);
    if (!savedId) return null;
    const snapshot = latestRef.current;
    const { jsonValues, pendingAttachments } = prepareValues(snapshot.values, uploadsRef.current);
    await documentsAPI.updateForm(savedId, jsonValues, pendingAttachments, { title: snapshot.title.trim() || "Untitled form" });
    return savedId;
  }, [saveNow]);

  const discardDraft = useCallback(async (): Promise<void> => {
    discardingRef.current = true;
    try {
      // Let any request already in progress finish so a just-created draft is
      // known before we delete it. A failed save may still have created a doc.
      if (inFlightRef.current) await inFlightRef.current.catch(() => undefined);
      const id = documentIdRef.current;
      if (id) await documentsAPI.delete(id);
      documentIdRef.current = null;
      setDocumentId(null);
      versionsRef.current = { current: 0, saved: 0 };
      uploadsRef.current.clear();
      setStatus("idle");
    } finally {
      discardingRef.current = false;
    }
  }, []);

  const saveNowRef = useRef(saveNow);
  saveNowRef.current = saveNow;

  // Route changes can unmount a form before its debounce timer fires. Flush
  // the latest state during unmount so ordinary navigation does not discard
  // the last keystrokes.
  useEffect(() => () => {
    if (!discardingRef.current && latestRef.current.dirty && versionsRef.current.current > versionsRef.current.saved) {
      void saveNowRef.current(true).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    if (!enabled || !dirty || !templateId) return;
    versionsRef.current.current += 1;
    setStatus("unsaved");
    const timer = window.setTimeout(() => { void saveNow().catch(() => undefined); }, 600);
    return () => window.clearTimeout(timer);
  }, [dirty, enabled, templateId, title, values, saveNow]);

  useEffect(() => {
    if (!enabled || !dirty || status === "saved") return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty, enabled, status]);

  return { documentId, status, saveNow, finalizeNow, discardDraft };
}
