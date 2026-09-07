import { File, X } from "lucide-react";
import { useEffect, useState } from "react";

type Props = {
  files: File[];
  onRemove: (index: number) => void;
  onClearAll: () => void;
  disabled?: boolean;
};

export default function BulkFileThumbnails({
  files,
  onRemove,
  onClearAll,
  disabled = false,
}: Props) {
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

  // Generate thumbnails for PDFs and images
  useEffect(() => {
    const newThumbnails: Record<string, string> = {};
    const urls: string[] = [];

    files.forEach((file) => {
      const key = `${file.name}-${file.size}`;
      if (file.type === "application/pdf" || file.type.startsWith("image/")) {
        const url = URL.createObjectURL(file);
        newThumbnails[key] = url;
        urls.push(url);
      }
    });

    setThumbnails(newThumbnails);

    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [files]);

  if (files.length === 0) return null;

  const totalMb = files.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);

  return (
    <div className="px-5 space-y-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{files.length} file{files.length === 1 ? "" : "s"} selected</span>
        <span>{totalMb.toFixed(2)} MB total</span>
      </div>
      
      {/* Thumbnail grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
        {files.map((file, index) => {
          const key = `${file.name}-${file.size}`;
          const thumbnail = thumbnails[key];
          const hasThumbnail = file.type === "application/pdf" || file.type.startsWith("image/");
          
          return (
            <div
              key={key}
              className="relative group border border-[#C8CDD2] bg-white rounded-lg overflow-hidden hover:border-[#287EAD] transition-colors"
            >
              {hasThumbnail && thumbnail ? (
                <div className="aspect-[3/4] bg-gray-100">
                  {file.type === "application/pdf" ? (
                    <iframe
                      src={thumbnail}
                      className="w-full h-full"
                      title={file.name}
                      loading="lazy"
                    />
                  ) : (
                    <img
                      src={thumbnail}
                      alt={file.name}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  )}
                </div>
              ) : (
                <div className="aspect-[3/4] bg-gray-100 flex items-center justify-center">
                  <File className="w-8 h-8 text-[#287EAD]" />
                </div>
              )}
              
              <div className="p-2">
                <p className="text-xs font-medium text-foreground truncate" title={file.name}>
                  {file.name}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {(file.size / (1024 * 1024)).toFixed(2)} MB
                </p>
              </div>
              
              <button
                type="button"
                disabled={disabled}
                onClick={() => onRemove(index)}
                className="absolute top-1 right-1 bg-white/90 hover:bg-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
              >
                <X className="w-3 h-3 text-destructive" />
              </button>
            </div>
          );
        })}
      </div>
      
      <button
        type="button"
        disabled={disabled}
        onClick={onClearAll}
        className="text-xs text-destructive hover:underline"
      >
        Clear all
      </button>
    </div>
  );
}