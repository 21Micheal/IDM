import { documentsAPI } from "@/services/api";

export const myRetirementsQueryKey = (userId?: string | null) => [
  "retirements",
  "my-unreconciled-requisitions",
  userId ?? "anonymous",
] as const;

export function isUnreconciledTravelRequisition(doc: any, userId?: string | null): boolean {
  const form = doc?.metadata?.form;
  const retirement = doc?.form_summary?.retirement;
  const status = String(doc?.status || "").toLowerCase();
  return Boolean(
    userId
    && String(doc?.uploaded_by?.id || "") === String(userId)
    && String(form?.workflow_type || "").toLowerCase() === "requisition"
    && retirement
    && retirement.status !== "reconciled"
    && !["draft", "rejected", "void", "archived"].includes(status)
  );
}

export async function fetchMyUnreconciledTravelRequisitions(userId?: string | null) {
  if (!userId) return [];
  const response = await documentsAPI.myRetirements();
  const results = Array.isArray(response.data) ? response.data : [];
  return results.filter((doc: any) => isUnreconciledTravelRequisition(doc, userId));
}
