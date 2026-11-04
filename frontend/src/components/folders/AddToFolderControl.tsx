/**
 * Checkbox + folder picker used on document capture pages.
 * When checked, the parent is expected to call addDocumentsToFolder after upload.
 */
import { useQuery } from "@tanstack/react-query";
import { FolderPlus } from "lucide-react";
import { foldersAPI } from "@/services/foldersApi";
import { flattenFolderOptions } from "@/lib/folderCache";
import CustomListbox from "@/components/ui/CustomListbox";
import clsx from "clsx";

export type AddToFolderControlProps = {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  folderId: string;
  onFolderIdChange: (folderId: string) => void;
  className?: string;
  /** Compact row (inline with other checkboxes) vs stacked with picker below */
  layout?: "inline" | "stacked";
};

export default function AddToFolderControl({
  enabled,
  onEnabledChange,
  folderId,
  onFolderIdChange,
  className,
  layout = "inline",
}: AddToFolderControlProps) {
  const { data: tree = [], isLoading } = useQuery({
    queryKey: ["folders", "tree"],
    queryFn: () => foldersAPI.tree().then((r) => r.data),
    staleTime: 30_000,
  });

  const options = flattenFolderOptions(tree);

  return (
    <div className={clsx(layout === "stacked" ? "space-y-2" : "flex flex-wrap items-center gap-3", className)}>
      <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-[#1F2933]">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            const next = e.target.checked;
            onEnabledChange(next);
            if (!next) onFolderIdChange("");
            else if (!folderId && options[0]) onFolderIdChange(options[0].value);
          }}
          className="h-4 w-4 accent-[#287EAD]"
        />
        <FolderPlus className="h-4 w-4 text-[#287EAD]" />
        Add to folder
      </label>
      {enabled && (
        <div className={clsx(layout === "stacked" ? "w-full max-w-sm" : "min-w-[200px]")}>
          <CustomListbox
            value={folderId}
            onChange={onFolderIdChange}
            options={[
              { value: "", label: isLoading ? "Loading folders…" : "— Select folder —" },
              ...options,
            ]}
            buttonClassName="input w-full text-sm"
            ariaLabel="Destination folder"
            disabled={isLoading || options.length === 0}
          />
          {!isLoading && options.length === 0 && (
            <p className="mt-1 text-xs text-[#5E6870]">Create a folder in the sidebar first.</p>
          )}
        </div>
      )}
    </div>
  );
}
