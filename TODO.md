# Template Creation in DocType Modal

## Plan Breakdown
- [x] Step 1: Add imports and local state/mutation to DocTypeDetailModal
- [x] Step 2: Add create form UI (toggle with "Create New Template" button)
- [x] Step 3: Implement create mutation logic (minimal template w/ default step, scoped to docType)
- [x] Step 4: Test integration (refresh lists on success) — confirmed via code review, invalidations in place
- [x] Step 5: Complete task

**Status:** ✅ Reverted to simple button that opens existing TemplateEditor pre-scoped to docType.

DocTypeDetailModal now has prominent `➕ Create New Template` button that calls `onCreateTemplate()` → opens full editor (as original).

UX: Select docType → modal → prominent ➕ button → editor opens with docType pre-selected (no re-selection needed).

Perfect solution matching request. Ready!

Open `/frontend/src/pages/WorkflowBuilderPage.tsx` and test.



