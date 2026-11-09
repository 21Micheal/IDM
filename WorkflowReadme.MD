### 1. Branched Workflow Implementation Overview

In [WorkflowBuilderPage.tsx](file:///home/michael/Projects/IDM/frontend/src/pages/WorkflowBuilderPage.tsx) and [BranchedWorkflowEditor.tsx](file:///home/michael/Projects/IDM/frontend/src/components/workflow/BranchedWorkflowEditor.tsx), workflows are modeled as hierarchical trees of blocks:
- **`approval`**: A standard human approval stage with assignee configuration (role, group, specific user, auto-selected HOD).
- **`notification`**: Automated email notification step that auto-advances without pausing.
- **`if_else`**: Compound conditional branching using boolean groups (`AND`/`OR`) and operators.
- **`switch` (`CASE`)**: Multi-way categorical branching on a single field.
- **`set_value`**: Variable assignment node to derive context flags (e.g. `var.risk = "high"`).
- **`end`**: Early completion node that terminates the workflow with an explicit outcome (`approved` or `rejected`) and an optional audit reason.

The frontend compiles this structure into a graph ([workflowGraph.ts](file:///home/michael/Projects/IDM/frontend/src/lib/workflowGraph.ts)), while saving a synchronous flat mirror in document order on `template.steps` to keep legacy relational queries intact. At runtime, the backend engine ([engine.py](file:///home/michael/Projects/IDM/apps/workflows/engine.py)) navigates the branched structure using the document’s evaluation context.

---

### 2. Use Cases: `CASE` (Switch) vs `IF` (If/Else)

| Feature | `CASE` (`switch` block) | `IF` (`if_else` block) |
| :--- | :--- | :--- |
| **Primary purpose** | Routing by a single categorical attribute with multiple known values. | Routing based on numerical thresholds, boolean flags, or multi-field rules. |
| **Conditions** | Single field (`field_id`) matching exact strings/values across cases + `default`. | Compound rules (`AND`/`OR`) with operators (`>`, `<`, `==`, `!=`, `in`, `between`, etc.). |
| **Currency conversion** | Exact matching on currency code (e.g., `USD`, `KES`). | Evaluates threshold amounts in specified currencies (e.g. `amount > 10,000 USD`). |
| **Best suited for** | • Document phase (`requisition`, `rfq`, `lpo`, `retirement`).<br>• Submitter department (`Finance`, `Engineering`, `Operations`).<br>• Currency routing (`USD`, `KES`, `EUR`). | • Amount thresholds (`amount > 50,000 USD`).<br>• Submitter group membership + amount criteria.<br>• Negative conditions (`Currency != "USD"`). |

---

### 3. Supported Variables for Conditions

Variables available to condition blocks come from two sources:

1. **System Fields** (available on all document workflows):
   - **`amount`** (`money`): Document total amount, automatically converted to the rule's target currency when exchange rates exist.
   - **`currency`** (`select`): The currency code of the document (e.g. `USD`, `KES`, `EUR`, `GBP`, etc.).
   - **`context.phase`** (`select`): Lifecycle phase (`requisition`, `rfq`, `lpo`, `request`, `retirement`, `payment_run`).
   - **`uploader.department`** (`text`): Submitter’s department name.
   - **`uploader.groups`** (`multiselect`): Submitter's active group IDs.
   - **`document.title`** (`text`) and **`document.created_at`** (`date`).
   - **`payment_run.line_count`** (`number`) and **`payment_run.total`** (`money`).
2. **Form / Metadata Fields**:
   - Any custom field defined in the template form or document type metadata (e.g., `requisition_type`, `cost_centre`, `vendor_category`).

---

### 4. Setting a Condition for "Currency is not USD" (Purchase Order Workflow)

#### The Existing PO Workflow Trace:
In the database, the PO Workflow (`6e253105-cd32-40ea-b227-4d44897b8a41`) was structured as:
1. **Block 1**: `HOD Approval` (Order 1).
2. **Block 2**: `If / Else` with condition: `amount > 10,000 USD`.
   - **True branch**: `Finance Approval` $\rightarrow$ nested `amount > 50,000 USD` $\rightarrow$ `Manager Approval`.
   - **Else branch**: `Complete early: Approved` with reason `"Currency not USD"`.

Because `currency` was previously missing from the field picker, the author approximated "Currency not USD" by relying on `amount > 10,000 USD` failing currency conversion for non-USD currencies (like KES), dropping into the `else` branch. If exchange rates were added, a 2.9M KES document (~$22,000 USD) would have unintentionally qualified as `> 10,000 USD`.

#### How to configure "Currency is not USD" directly:
With `currency` now added to [engine.py](file:///home/michael/Projects/IDM/apps/workflows/engine.py), [services.py](file:///home/michael/Projects/IDM/apps/workflows/services.py), and [workflowGraph.ts](file:///home/michael/Projects/IDM/frontend/src/lib/workflowGraph.ts):

* **Method 1: Direct `If / Else` Rule**
  1. Add an **If / Else** block after HOD Approval.
  2. In the branch condition, select:
     - **Field**: `Currency`
     - **Operator**: `≠` (`neq`)
     - **Value**: `USD`
  3. Inside this branch, attach a **Complete early** block (`Outcome: Approved`, `Reason: Currency not USD`).
  4. In the `ELSE` branch (which now cleanly represents USD), place your USD amount rules (`amount > 10,000 USD`).

* **Method 2: `Switch` (CASE) on Currency**
  1. Add a **Switch** block after HOD Approval.
  2. **Branch on field**: `Currency`.
  3. **CASE 1**: Values: `USD` $\rightarrow$ contains Finance & Manager approval thresholds.
  4. **DEFAULT / Other**: `Complete early: Approved` or local KES approval stages.

---

### 5. Why [ApprovalStagesTable.tsx](file:///home/michael/Projects/IDM/frontend/src/components/workflow/ApprovalStagesTable.tsx) and [workflow-visualizer.tsx](file:///home/michael/Projects/IDM/frontend/src/components/notifications/workflow-visualizer.tsx) Displayed 3 Stages for `LPO-00013`

#### Root Cause:
1. For `LPO-00013` (`currency: KES`), the backend engine executed Step 1 (`HOD Approval`) and branched to the `end` node, completing the workflow with status `approved`. No task was ever created for Step 2 (`Finance Approval`) or Step 3 (`Manager Approval`).
2. When the frontend loaded workflow data via `loadWorkflowData` in [workflow-data.ts](file:///home/michael/Projects/IDM/frontend/src/components/notifications/workflow-data.ts), it fetched `template.steps` which returned all 3 steps in the template's flat mirror (`[1, 2, 3]`).
3. `phaseOrdersFromDefinition` only filtered steps if there was a `switch` on `context.phase`. For amount/currency branched workflows, it returned `null`, including all 3 steps in `sourceSteps`.
4. In Pass 1, steps without tasks were initialized as `"pending"`.
5. In Pass 2, steps were only changed from `"pending"` to `"skipped"` if the workflow was rejected (`terminated`). Because `LPO-00013` was `status === "approved"`, Steps 2 and 3 remained `"pending"`, displaying phantom upcoming approval stages in both the table and visualizer.

#### Changes Implemented:
1. **Serialized Active Path**:
   - In [serializers.py](file:///home/michael/Projects/IDM/apps/workflows/serializers.py), added `active_step_orders` to `WorkflowInstanceSerializer`, computed via `WorkflowService._v2_active_step_orders(instance)`. For `LPO-00013`, this returns `[1]`.
2. **Active Path Filtering**:
   - In [workflow-data.ts](file:///home/michael/Projects/IDM/frontend/src/components/notifications/workflow-data.ts), `buildApproverWorkflow` now filters `sourceSteps` using `active_step_orders`. Any steps belonging to inactive branches that were never executed are excluded from display.
3. **Completed Instance Resolution**:
   - In Pass 2 of [workflow-data.ts](file:///home/michael/Projects/IDM/frontend/src/components/notifications/workflow-data.ts), when an instance has concluded (`approved`, `completed`, `rejected`, or `cancelled`), any step without tasks is marked `"skipped"` rather than remaining `"pending"`.
4. **Currency Variable Support**:
   - Added `currency` as a select field in `SYSTEM_FIELDS` across [engine.py](file:///home/michael/Projects/IDM/apps/workflows/engine.py) and [workflowGraph.ts](file:///home/michael/Projects/IDM/frontend/src/lib/workflowGraph.ts).
   - Populated `context["currency"]` and `context["document.currency"]` in `WorkflowService.build_evaluation_context` in [services.py](file:///home/michael/Projects/IDM/apps/workflows/services.py).
   - Normalized case comparison in `switch` blocks in [engine.py](file:///home/michael/Projects/IDM/apps/workflows/engine.py).
