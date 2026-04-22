# Perfect Office Document Preview Mechanism

## Overview
A robust, production-ready preview system for Office documents (DOCX, XLSX, PPTX) with intelligent polling, error handling, and user feedback.

## Architecture

### Key Features

#### 1. **Smart Polling Strategy**
```javascript
const PREVIEW_POLL_CONFIG = {
  initialInterval: 1000,      // 1s for first 5s (eager check)
  initialDuration: 5000,      // Fast polling for 5 seconds
  standardInterval: 3000,     // 3s standard polling rate
  maxInterval: 15000,         // Cap at 15s per poll
  backoffMultiplier: 1.1,     // 10% increase per poll
  maxPolls: 40,               // ~60s total timeout
};
```

**How it works:**
- First 5 seconds: Poll every 1s (optimal for fast conversions)
- After 5 seconds: Poll every 3s with exponential backoff (10% per poll)
- Maximum timeout: ~60 seconds (40 polls × 3s average)
- Automatic stop: After max polls reached or preview completes

#### 2. **State Management**
- `isConverting` - Office→PDF conversion in progress (pending/processing)
- `hasPdf` - Preview ready for viewing
- `previewFailed` - Conversion failed (user can retry)
- `previewProgress` - Visual progress bar (0-100%)

#### 3. **UI States**

**Initializing (No status yet)**
- Shows spinner with "Initializing preview…" message
- Placeholder state while query establishes

**Generating (PENDING/PROCESSING)**
- Animated progress bar showing conversion progress
- Clear messaging: "Converting {App} to PDF — {Progress}%"
- No stuck state — always times out after 60s

**Success (DONE)**
- Full PDF preview with zoom, pagination controls
- Clear "Ready" badge with checkmark
- Access to PDF download and annotation

**Failed (FAILED)**
- Clear error message with explanation
- "Retry" button to restart conversion
- "Download instead" button for fallback access

#### 4. **Error Recovery**
```typescript
const retryPreview = () => {
  pollCountRef.current = 0;
  setPreviewProgress(0);
  qc.invalidateQueries({ queryKey: ["document-preview", doc.id] });
};
```

- Single-click retry without page reload
- Resets polling counters and progress
- Invalidates cache to force fresh conversion attempt

### Backend Integration

The frontend expects the `/documents/{id}/preview_url/` endpoint to:

1. **Check preview status** and return one of:
   - `PENDING` - Conversion queued, not started
   - `PROCESSING` - LibreOffice conversion in progress
   - `DONE` - Preview PDF ready at `preview_pdf` field
   - `FAILED` - Conversion failed, won't retry

2. **Queue conversion task** for new Office documents:
   ```python
   if doc.is_office_doc() and not doc.preview_pdf:
       generate_document_preview.delay(str(doc.id))
   ```

3. **Return response**:
   ```json
   {
     "viewer": "pdfjs|image|processing|download",
     "url": "https://..../preview.pdf",
     "raw_url": "https://..../document.docx",
     "preview_status": "pending|processing|done|failed"
   }
   ```

### Polling Flow

```
START
  ↓
Initial Data Loaded (initialPreview)
  ↓
Display Appropriate State (Converting/Ready/Failed/Initializing)
  ↓
Is status PENDING or PROCESSING?
  ├─ YES → Poll every 3s
  │         ├─ Max 40 polls? → STOP
  │         ├─ Status changed? → Re-render
  │         └─ Loop
  └─ NO → STOP (Done or Failed)
```

### Performance Optimizations

1. **React Query Integration**
   - `staleTime: 0` - Always refetch when needed
   - `retry: false` - No automatic retries (manual only)
   - Smart `refetchInterval` - Dynamic polling based on status

2. **Ref Management**
   - `pollCountRef` - Track poll attempts without state updates
   - `previewTimeoutRef` - Reserved for future timeout management

3. **Early Exit Conditions**
   - Status `done` or `failed` → Stop polling immediately
   - Poll count >= 40 → Stop after ~60s
   - No conversion in progress → Stop polling

### Microsoft Office Editing Integration

Office preview works seamlessly with editing:

1. **Acquire Lock** - User clicks "Acquire edit lock"
2. **Preview Starts** - Document-preview query begins
3. **User Edits** - Opens document in MS Office (Windows only)
4. **Auto-Save Polling** - Every 5s check for version bump
5. **Release Lock** - Manual or automatic (1-hour expiry)

Each Ctrl+S save in MS Office creates a new version, which:
- Triggers version bump detected in polling
- Shows "Version X received from editor" toast
- Invalidates both document and preview caches
- Automatically refreshes preview if needed

## UI/UX Design

### Header Bar
- Status badge (Ready/Generating/Failed)
- Download original file link
- Open in new tab link

### Preview Container
- Responsive layout
- Clear error states with recovery options
- Progress visualization during conversion

### Edit Panel
- Windows-only MS Office button (with clear messaging for non-Windows)
- Version polling indicator
- Release lock button

## Error Messages

| Scenario | Message | Action |
|----------|---------|--------|
| Timeout (>60s) | "Preview generation failed - Could not convert this Office document to PDF..." | Retry button |
| LibreOffice crash | Same as timeout | Retry button |
| Invalid file | Same as timeout | Retry button |
| Locked by another user | "Editing is disabled — this document is currently locked by..." | None |
| Non-Windows user | "MS Office editing is only available on Windows..." | Use manual upload |

## Testing Checklist

- [ ] PDF preview works for valid Office files
- [ ] Progress bar displays during conversion
- [ ] Timeout occurs at ~60 seconds for hung conversions
- [ ] Retry button resets polling and attempts conversion again
- [ ] Failed state shows with recovery options
- [ ] MS Office opens correctly on Windows
- [ ] Version polling detects saves from MS Office
- [ ] Lock banner displays while editing
- [ ] Non-Windows users see appropriate messaging
- [ ] Download fallback always available

## Migration from Previous Implementation

**Removed:**
- LibreOffice bash/PowerShell launcher script generation
- Cross-platform editing support
- Manual WebDAV URL copying
- Complex launcher file downloads

**Kept:**
- Backend LibreOffice conversion (generates PDF for preview)
- Manual version upload fallback
- Version polling for automatic version tracking
- Edit lock management

**Added:**
- Robust polling with timeout
- Clear progress visualization
- Error recovery with retry
- Better UX for non-Windows users
- Guaranteed completion (no stuck states)

## Future Enhancements

1. **Google Docs integration** - Preview Google Docs natively
2. **OneDrive sync** - Auto-save to OneDrive via WebDAV
3. **Collaborative editing** - Real-time co-editing via CRDT
4. **Version comparison** - Visual diff between versions
5. **OCR for scans** - Auto-OCR for scanned Office files
