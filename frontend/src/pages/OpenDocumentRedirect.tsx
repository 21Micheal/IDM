/**
 * Resolves legacy bare /{uuid} and /open/{uuid} links to the correct workspace:
 *   /forms/:id  — built forms (Imprest, Requisition, …)
 *   /documents/:id — uploaded / scanned documents
 *
 * Notification emails and older clients still emit /{id}; without this redirect
 * those paths fall through App's catch-all to the dashboard.
 */
import { useEffect } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { documentsAPI } from "@/services/api";
import {
  getDocumentWorkspacePath,
  isDocumentUuid,
} from "@/lib/documentWorkspace";

export default function OpenDocumentRedirect() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const validId = id && isDocumentUuid(id) ? id : null;

  const { data, isError, isLoading } = useQuery({
    queryKey: ["document-workspace-resolve", validId],
    queryFn: () => documentsAPI.get(validId!).then((r) => r.data),
    enabled: Boolean(validId),
    staleTime: 30_000,
    retry: 1,
  });

  useEffect(() => {
    if (!validId) {
      navigate("/", { replace: true });
      return;
    }
    if (isError) {
      navigate(`/documents/${validId}${searchParams.toString() ? `?${searchParams}` : ""}`, {
        replace: true,
      });
      return;
    }
    if (!data) return;

    const taskId = searchParams.get("task");
    const path = getDocumentWorkspacePath(data, {
      taskId,
      query: Object.fromEntries(
        [...searchParams.entries()].filter(([key]) => key !== "task"),
      ),
    });
    navigate(path, { replace: true });
  }, [validId, data, isError, navigate, searchParams]);

  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="flex items-center gap-3 text-sm text-[#5E6870]">
        <Loader2 className={`h-5 w-5 ${isLoading ? "animate-spin" : ""} text-[#287EAD]`} />
        Opening document…
      </div>
    </div>
  );
}
