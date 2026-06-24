# Comprehensive PDF Editor (Sejda-style)

A self-contained, client-first PDF editing suite for your DMS. pdf-lib does the
editing, pdf.js does the rendering. Heavy operations are emitted as backend jobs.

## Install

```bash
npm i pdf-lib pdfjs-dist clsx lucide-react
```

Lives at `src/components/pdf-editor/`. It reuses the app's existing
`src/components/profile/SignaturePad.tsx` for the Sign tool.

## Usage

```tsx
import PdfEditor from "@/components/pdf-editor";

<PdfEditor
  initialFiles={[fileOrUrlOrBytes]}      // optional
  signerName="Jane Doe"
  onSave={async ({ blobs }) => {          // save back to your DMS
    await documentsAPI.upload(blobs[0].name, blobs[0].bytes);
  }}
  onJob={async (job) => {                 // server-side ops
    // job.type: "compress" | "convert" | "protect" | "unlock" | "redact"
    const res = await api.pdfJob(job);    // send job.bytes + job.params
    return res.bytes;                     // return processed Uint8Array (or null)
  }}
  disabledTools={["bates"]}               // hide tools you don't need
/>
```

## What runs where

| Capability | Runtime |
|---|---|
| View / reorder / rotate / delete / duplicate / extract / insert / merge / split | client |
| Text, image, signature, shapes, lines, highlight, whiteout, freehand, links | client |
| Watermark, page numbers, header/footer, Bates, metadata | client |
| Compress (low/medium), PDF↔images, images→PDF | client |
| Compress (high/extreme), Office↔PDF, HTML→PDF, password protect/unlock, OCR-redact | **backend** via `onJob` |

Form design and OCR are intentionally excluded (you already have them).

## Notes

- All annotation geometry is stored as page fractions (0–1), so it survives zoom
  and exports at full resolution.
- Redaction draws an opaque box. For *true* content removal (stripping the text
  underneath), route a `redact` job to your backend.
- Annotations are authored at page rotation 0. If you rotate a page and then add
  annotations, stamp them before rotating for pixel-perfect placement.
```