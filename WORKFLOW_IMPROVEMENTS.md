# Workflow Improvements - Bulk Actions & Notifications

## Changes Made

### 1. Fixed Bulk Action Logic (Part 1)
**Files Modified:**
- `apps/documents/serializers.py`
- `apps/documents/views.py`
- `frontend/src/types/index.ts`
- `frontend/src/pages/DocumentsPage.tsx`

**Changes:**
- Added `available_bulk_actions` field to `DocumentListSerializer`
- Implemented `get_available_bulk_actions()` method that respects:
  - Workflow task assignment and status
  - Step-level permissions (`allow_approve`, `allow_reject`, `allow_return`)
  - Document status restrictions
- Updated bulk_action view to check step permissions before executing actions
- Frontend now calculates the intersection of available actions across all selected documents
- Only shows action buttons that are valid for every selected document

### 2. Step Permission Validation
**Files Modified:**
- `apps/documents/views.py`

**Changes:**
- Enhanced `bulk_action()` endpoint to validate:
  - `allow_approve` permission before approving documents
  - `allow_reject` permission before rejecting documents
- Updated task status filter to include both `in_progress` and `held` tasks

### 3. Fixed Workflow Action Notifications
**Files Modified:**
- `apps/workflows/services.py`
- `apps/notifications/tasks.py`

**Changes:**
- **approve()**: Now calls `_notify_action()` to notify stakeholders
- **reject()**: Now calls `_notify_action()` to notify stakeholders
- **hold()**: Already calling `_notify_action()`
- **release_hold()**: Already calling `_notify_action()`
- **return_for_review()**: Already calling `_notify_action()`
- Added comprehensive `notify_workflow_action` task that handles all action types:
  - **Approved**: Notifies uploader of approval with step information
  - **Rejected**: Notifies uploader of rejection with reason
  - **Returned**: Notifies uploader of return with destination
  - **Held**: Notifies uploader of hold with duration
  - **Released**: Notifies uploader and approver of hold release

### 4. Enhanced Frontend Safeguards
**Files Modified:**
- `frontend/src/components/workflow/WorkflowActionPanel.tsx`

**Changes:**
- Improved action button visibility logic with safer optional chaining (`?.`)
- Changed checks to use `!== false` to be more explicit
- Added helpful tooltips for each action explaining constraints
- Ensures buttons don't appear if step permissions are disabled

## How It Works

### Bulk Actions Flow
1. **Frontend**: User selects multiple documents
2. **API**: DocumentListSerializer returns `available_bulk_actions` for each document
3. **Frontend**: Calculates intersection of all selected documents' available actions
4. **UI**: Only displays action buttons that are available for ALL selected documents
5. **Backend**: Validates permissions again before executing actions
6. **Notifications**: Sends both in-app and email notifications

### Notification System
1. When an action is taken (approve, reject, return, hold, release):
   - A `WorkflowTaskAction` record is created
   - `_notify_action()` is called with the action record
   - Async `notify_workflow_action` task is queued
2. Task sends notifications to:
   - **Document uploader** (always)
   - **Other specified users** (based on action type)
3. Notifications include:
   - **In-app notification**: Quick message with document reference
   - **Email**: Detailed information with action context

### Step Permission Checks
- **Frontend**: Shows/hides buttons based on `task.step.allow_*` fields
- **Backend**: Returns error if action not permitted for step
- **Bulk Actions**: Only appears in intersection if allowed for all selected docs

## Permissions Respected

### For Approvers
- ✓ `allow_approve` - Can approve documents at this step
- ✓ `allow_reject` - Can reject documents at this step  
- ✓ `allow_return` - Can send documents back for review
- Hold - Always available (not configurable per step)

### For Bulk Actions on Workflow Documents
- **Approve**: Only if assigned to active task with `allow_approve=true`
- **Reject**: Only if assigned to active task with `allow_reject=true`
- **Archive**: Only for approved documents
- **Void**: For all documents except archived/void

### For Bulk Actions on Personal Documents
- **Archive**: Only for non-archived documents
- **Delete**: Available for all personal documents

## Notification Messages

### In-App Notifications
```
✓ Approved: Your document 'Invoice #123' has been approved by John Smith.
✗ Rejected: Your document 'Invoice #123' has been rejected by John Smith.
↩ Returned: Your document 'Invoice #123' has been returned for review.
⏸ On Hold: Your document 'Invoice #123' has been placed on hold for 24 hours.
▶ Released: The hold on your document 'Invoice #123' has been released.
```

### Email Notifications
- Detailed context including:
  - Document title and reference number
  - Action taken by whom
  - Reason/comment (if provided)
  - Step information
  - Any required follow-up actions

## Testing Checklist

- [ ] Create workflow template with steps that have mixed permissions
  - Step 1: allow_approve=true, allow_reject=false, allow_return=true
  - Step 2: allow_approve=true, allow_reject=true, allow_return=false
- [ ] Verify reject button does NOT appear for Step 1
- [ ] Verify return button does NOT appear for Step 2
- [ ] Verify bulk action buttons show only common permissions
- [ ] Send document through approval and verify notifications are sent
- [ ] Test approve/reject/return/hold actions and verify in-app + email notifications
- [ ] Check notifications appear in NotificationsPage in real-time
- [ ] Verify email is sent to correct recipients

## Related Configuration

No database migrations required - only logic/notification changes.

Ensure Celery is running for notifications:
```bash
celery -A IDM worker -l info -Q notifications
```

## Files Changed Summary

| File | Changes |
|------|---------|
| `apps/documents/serializers.py` | Added available_bulk_actions field |
| `apps/documents/views.py` | Enhanced bulk_action validation |
| `apps/workflows/services.py` | Added _notify_action calls to approve/reject |
| `apps/notifications/tasks.py` | Added notify_workflow_action task |
| `frontend/src/types/index.ts` | Added available_bulk_actions interface |
| `frontend/src/pages/DocumentsPage.tsx` | Implement action intersection logic |
| `frontend/src/components/workflow/WorkflowActionPanel.tsx` | Enhanced safeguards |
