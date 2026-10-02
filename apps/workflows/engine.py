"""
apps/workflows/engine.py

Branched workflow engine (v2). Port of the TypeScript workflowGraph.ts logic.

This module provides:
- Evaluation of conditions (rules and groups)
- Compilation of workflow definitions to execution graphs
- Validation of workflow definitions
- Path enumeration for testing/verification

The engine follows the exact semantics defined in the frontend workflowGraph.ts
to ensure backend-frontend compatibility.
"""

from typing import Any, Dict, List, Optional, Set, Tuple, Union
from datetime import datetime, timedelta
import json
import logging

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Types and Constants
# ─────────────────────────────────────────────────────────────────────────────

class FieldType:
    NUMBER = "number"
    MONEY = "money"
    TEXT = "text"
    SELECT = "select"
    MULTISELECT = "multiselect"
    BOOLEAN = "boolean"
    DATE = "date"
    USER = "user"
    GROUP = "group"


class Operator:
    EQ = "eq"
    NEQ = "neq"
    GT = "gt"
    GTE = "gte"
    LT = "lt"
    LTE = "lte"
    BETWEEN = "between"
    IN = "in"
    NOT_IN = "not_in"
    CONTAINS = "contains"
    NOT_CONTAINS = "not_contains"
    STARTS_WITH = "starts_with"
    ENDS_WITH = "ends_with"
    IS_EMPTY = "is_empty"
    IS_NOT_EMPTY = "is_not_empty"
    IS_TRUE = "is_true"
    IS_FALSE = "is_false"
    BEFORE = "before"
    AFTER = "after"
    WITHIN_LAST_DAYS = "within_last_days"
    CONTAINS_ANY = "contains_any"
    CONTAINS_ALL = "contains_all"


# Operators that are true when the field is empty (besides is_empty)
TRUE_WHEN_EMPTY = {Operator.NEQ, Operator.NOT_IN, Operator.NOT_CONTAINS, Operator.IS_FALSE}

# Operators by field type
OPERATORS_BY_TYPE = {
    FieldType.NUMBER: [
        Operator.EQ, Operator.NEQ, Operator.GT, Operator.GTE, Operator.LT, Operator.LTE,
        Operator.BETWEEN, Operator.IS_EMPTY, Operator.IS_NOT_EMPTY,
    ],
    FieldType.MONEY: [
        Operator.EQ, Operator.NEQ, Operator.GT, Operator.GTE, Operator.LT, Operator.LTE,
        Operator.BETWEEN, Operator.IS_EMPTY, Operator.IS_NOT_EMPTY,
    ],
    FieldType.TEXT: [
        Operator.EQ, Operator.NEQ, Operator.CONTAINS, Operator.NOT_CONTAINS,
        Operator.STARTS_WITH, Operator.ENDS_WITH, Operator.IN, Operator.NOT_IN,
        Operator.IS_EMPTY, Operator.IS_NOT_EMPTY,
    ],
    FieldType.SELECT: [
        Operator.EQ, Operator.NEQ, Operator.IN, Operator.NOT_IN,
        Operator.IS_EMPTY, Operator.IS_NOT_EMPTY,
    ],
    FieldType.MULTISELECT: [
        Operator.CONTAINS_ANY, Operator.CONTAINS_ALL,
        Operator.IS_EMPTY, Operator.IS_NOT_EMPTY,
    ],
    FieldType.BOOLEAN: [Operator.IS_TRUE, Operator.IS_FALSE],
    FieldType.DATE: [
        Operator.EQ, Operator.BEFORE, Operator.AFTER, Operator.BETWEEN,
        Operator.WITHIN_LAST_DAYS, Operator.IS_EMPTY, Operator.IS_NOT_EMPTY,
    ],
    FieldType.USER: [
        Operator.EQ, Operator.NEQ, Operator.IN, Operator.NOT_IN,
        Operator.IS_EMPTY, Operator.IS_NOT_EMPTY,
    ],
    FieldType.GROUP: [
        Operator.EQ, Operator.NEQ, Operator.IN, Operator.NOT_IN,
        Operator.IS_EMPTY, Operator.IS_NOT_EMPTY,
    ],
}


# ─────────────────────────────────────────────────────────────────────────────
# System Fields (built-in fields available for all workflows)
# ─────────────────────────────────────────────────────────────────────────────

SYSTEM_FIELDS = [
    {
        "id": "amount",
        "label": "Amount",
        "type": FieldType.MONEY,
        "source": "system",
    },
    {
        "id": "context.phase",
        "label": "Workflow phase",
        "type": FieldType.SELECT,
        "source": "system",
        "options": [
            {"value": "requisition", "label": "Requisition"},
            {"value": "rfq", "label": "RFQ"},
            {"value": "lpo", "label": "LPO"},
            {"value": "request", "label": "Request"},
            {"value": "retirement", "label": "Retirement"},
            {"value": "payment_run", "label": "Payment run"},
        ],
    },
    {
        "id": "uploader.groups",
        "label": "Submitter's groups",
        "type": FieldType.MULTISELECT,
        "source": "system",
    },
    {
        "id": "uploader.department",
        "label": "Submitter's department",
        "type": FieldType.TEXT,
        "source": "system",
    },
    {
        "id": "document.title",
        "label": "Document title",
        "type": FieldType.TEXT,
        "source": "system",
    },
    {
        "id": "document.created_at",
        "label": "Date submitted",
        "type": FieldType.DATE,
        "source": "system",
    },
    {
        "id": "payment_run.line_count",
        "label": "Payment run: line count",
        "type": FieldType.NUMBER,
        "source": "system",
    },
    {
        "id": "payment_run.total",
        "label": "Payment run: total",
        "type": FieldType.MONEY,
        "source": "system",
    },
]


def build_field_map_from_document_type(document_type) -> Dict[str, Dict[str, Any]]:
    """
    Build a field map from a document type's form / metadata fields.

    Form fields live on DocumentTemplate.sections (templates_engine). Admin-defined
    attribute fields live on DocumentType.metadata_fields. System fields are always
    included.
    """
    field_map = {f["id"]: f for f in SYSTEM_FIELDS}

    type_mapping = {
        "currency": FieldType.MONEY,
        "money": FieldType.MONEY,
        "amount": FieldType.MONEY,
        "number": FieldType.NUMBER,
        "integer": FieldType.NUMBER,
        "decimal": FieldType.NUMBER,
        "float": FieldType.NUMBER,
        "select": FieldType.SELECT,
        "dropdown": FieldType.SELECT,
        "radio": FieldType.SELECT,
        "choice": FieldType.SELECT,
        "multiselect": FieldType.MULTISELECT,
        "multi_select": FieldType.MULTISELECT,
        "checkbox_group": FieldType.MULTISELECT,
        "tags": FieldType.MULTISELECT,
        "checkbox": FieldType.BOOLEAN,
        "boolean": FieldType.BOOLEAN,
        "switch": FieldType.BOOLEAN,
        "toggle": FieldType.BOOLEAN,
        "date": FieldType.DATE,
        "datetime": FieldType.DATE,
    }

    def add_field(field: Dict[str, Any], source: str = "form") -> None:
        if not isinstance(field, dict):
            return
        field_id = field.get("id") or field.get("key") or field.get("name")
        if not field_id:
            return
        field_id = str(field_id)
        field_type = type_mapping.get(str(field.get("type", "")).lower(), FieldType.TEXT)

        options = []
        raw_opts = field.get("options") or field.get("select_options") or []
        if isinstance(raw_opts, list):
            for opt in raw_opts:
                if isinstance(opt, str):
                    options.append({"value": opt, "label": opt})
                elif isinstance(opt, dict):
                    options.append({
                        "value": str(opt.get("value") or opt.get("id") or opt.get("label")),
                        "label": str(opt.get("label") or opt.get("value") or opt.get("id")),
                    })

        field_map[field_id] = {
            "id": field_id,
            "label": str(field.get("label") or field.get("title") or field_id),
            "type": field_type,
            "options": options if options else None,
            "source": source,
        }
        # Builder forms often key conditions by `key` while the block stores `id`.
        key = field.get("key")
        if key and str(key) != field_id:
            field_map[str(key)] = {**field_map[field_id], "id": str(key)}

    # Admin-defined metadata attributes on the document type
    try:
        for mf in document_type.metadata_fields.all():
            add_field(
                {
                    "id": mf.key,
                    "key": mf.key,
                    "label": mf.label,
                    "type": mf.field_type,
                    "select_options": mf.select_options,
                },
                source="metadata",
            )
    except Exception:
        logger.debug("Could not load metadata_fields for document type %s", getattr(document_type, "pk", None), exc_info=True)

    # Interactive form templates attached to this document type
    try:
        from apps.templates_engine.models import DocumentTemplate

        templates = DocumentTemplate.objects.filter(
            document_type_id=document_type.pk,
            is_active=True,
            kind="form",
        )
        for tmpl in templates:
            sections = tmpl.sections if isinstance(tmpl.sections, list) else []
            for section in sections:
                if not isinstance(section, dict):
                    continue
                for field in section.get("fields") or []:
                    add_field(field, source="form")
    except Exception:
        logger.debug("Could not load form templates for document type %s", getattr(document_type, "pk", None), exc_info=True)

    return field_map


# ─────────────────────────────────────────────────────────────────────────────
# Evaluation Context
# ─────────────────────────────────────────────────────────────────────────────

class EvalContext:
    """Context for evaluating workflow conditions."""
    
    def __init__(
        self,
        values: Dict[str, Any],
        vars: Optional[Dict[str, Any]] = None,
        rates: Optional[Dict[str, float]] = None,
        now: Optional[datetime] = None,
    ):
        self.values = values
        self.vars = vars or {}
        self.rates = rates or {}
        self.now = now or datetime.utcnow()
        self.warnings: List[str] = []


# ─────────────────────────────────────────────────────────────────────────────
# Helper Functions
# ─────────────────────────────────────────────────────────────────────────────

def get_value(ctx: EvalContext, field_id: str) -> Any:
    """Get a value from the context, handling nested keys and variables."""
    if field_id.startswith("var."):
        return ctx.vars.get(field_id[4:])
    
    if field_id in ctx.values:
        return ctx.values[field_id]
    
    # Handle nested keys (e.g., "uploader.department")
    if "." in field_id:
        parts = field_id.split(".")
        current = ctx.values
        for part in parts:
            if current is None:
                return None
            current = current.get(part) if isinstance(current, dict) else None
        return current
    
    return None


def is_money(value: Any) -> bool:
    """Check if a value is a money object (has amount and optional currency)."""
    return (
        isinstance(value, dict)
        and "amount" in value
        and not isinstance(value, list)
    )


def is_empty_value(value: Any) -> bool:
    """Check if a value is considered empty."""
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    if isinstance(value, list):
        return len(value) == 0
    if isinstance(value, (int, float)):
        # NaN check
        try:
            return value != value  # NaN != NaN is True
        except:
            return False
    if is_money(value):
        return is_empty_value(value.get("amount"))
    return False


def to_number(value: Any) -> Optional[float]:
    """Convert a value to a number."""
    if is_money(value):
        return to_number(value.get("amount"))
    if isinstance(value, (int, float)):
        if isinstance(value, float):
            # Check for NaN
            return value if value == value else None
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace(",", "").strip()
        if not cleaned:
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def convert_currency(
    amount: float,
    from_currency: Optional[str],
    to_currency: Optional[str],
    rates: Dict[str, float],
    warnings: List[str],
) -> Optional[float]:
    """Convert amount from one currency to another using exchange rates."""
    if not from_currency or not to_currency or from_currency == to_currency:
        return amount
    
    if not rates.get(from_currency) or not rates.get(to_currency):
        warnings.append(
            f"No exchange rate to compare {from_currency} with {to_currency}; "
            "condition treated as not matching."
        )
        return None
    
    try:
        return (amount * rates[from_currency]) / rates[to_currency]
    except (ZeroDivisionError, TypeError):
        warnings.append(
            f"Invalid exchange rate for {from_currency} or {to_currency}; "
            "condition treated as not matching."
        )
        return None


def to_string(value: Any) -> str:
    """Convert a value to string."""
    return str(value) if value is not None else ""


def to_list(value: Any) -> List[str]:
    """Convert a value to a list of strings."""
    if isinstance(value, list):
        return [to_string(v) for v in value]
    if isinstance(value, str):
        if value.strip():
            return [v.strip() for v in value.split(",") if v.strip()]
    return []


# ─────────────────────────────────────────────────────────────────────────────
# Rule Evaluation
# ─────────────────────────────────────────────────────────────────────────────

def eval_rule(
    rule: Dict[str, Any],
    field_map: Dict[str, Dict[str, Any]],
    ctx: EvalContext,
) -> bool:
    """
    Evaluate a single condition rule.
    
    Args:
        rule: Rule dict with keys: field_id, op, value, value2, currency, value_ref
        field_map: Map of field_id to field metadata (type, options, etc.)
        ctx: Evaluation context with values, variables, rates, etc.
    
    Returns:
        True if the rule matches, False otherwise.
    """
    field_id = rule.get("field_id")
    op = rule.get("op")
    
    if not field_id or not op:
        ctx.warnings.append("Incomplete condition ignored.")
        return False
    
    field = field_map.get(field_id, {})
    raw = get_value(ctx, field_id)
    
    # Infer type from field metadata or raw value
    field_type = field.get("type")
    if not field_type:
        if is_money(raw):
            field_type = FieldType.MONEY
        elif isinstance(raw, (int, float)):
            field_type = FieldType.NUMBER
        elif isinstance(raw, bool):
            field_type = FieldType.BOOLEAN
        elif isinstance(raw, list):
            field_type = FieldType.MULTISELECT
        else:
            field_type = FieldType.TEXT
    
    # Handle empty-value operators
    if op == Operator.IS_EMPTY:
        return is_empty_value(raw)
    if op == Operator.IS_NOT_EMPTY:
        return not is_empty_value(raw)
    if is_empty_value(raw):
        return op in TRUE_WHEN_EMPTY
    
    # Get right-hand operand (literal or field reference)
    value_ref = rule.get("value_ref")
    if value_ref:
        rhs = get_value(ctx, value_ref)
    else:
        rhs = rule.get("value")
    
    # Evaluate based on field type
    if field_type in (FieldType.NUMBER, FieldType.MONEY):
        return _eval_numeric_rule(raw, rhs, op, rule, field_type, ctx)
    elif field_type == FieldType.BOOLEAN:
        return _eval_boolean_rule(raw, op)
    elif field_type == FieldType.DATE:
        return _eval_date_rule(raw, rhs, op, rule, ctx)
    elif field_type in (FieldType.TEXT, FieldType.SELECT, FieldType.USER, FieldType.GROUP):
        return _eval_text_rule(raw, rhs, op, field_type)
    elif field_type == FieldType.MULTISELECT:
        return _eval_multiselect_rule(raw, rhs, op)
    
    ctx.warnings.append(f"Unsupported field type: {field_type}")
    return False


def _eval_numeric_rule(
    raw: Any,
    rhs: Any,
    op: str,
    rule: Dict[str, Any],
    field_type: str,
    ctx: EvalContext,
) -> bool:
    """Evaluate a numeric or money field rule."""
    left_num = to_number(raw)
    if left_num is None:
        return False
    
    left_currency = raw.get("currency") if is_money(raw) else None
    cmp_currency = rule.get("currency") or left_currency
    
    # Convert left side to comparison currency if needed
    left = left_num
    if field_type == FieldType.MONEY and not rule.get("value_ref") and rule.get("currency") and left_currency:
        left = convert_currency(left_num, left_currency, rule.get("currency"), ctx.rates, ctx.warnings)
        if left is None:
            return False
    
    # Get right-hand side as number
    def right_as_number(val: Any) -> Optional[float]:
        n = to_number(val)
        if n is None:
            return None
        if rule.get("value_ref") and is_money(val) and left_currency:
            return convert_currency(n, val.get("currency"), left_currency, ctx.rates, ctx.warnings)
        return n
    
    right = right_as_number(rhs)
    if rule.get("value_ref"):
        cmp_currency = left_currency
    
    if left is None:
        return False
    
    if op == Operator.BETWEEN:
        value2 = rule.get("value2")
        right2 = to_number(value2)
        if right is None or right2 is None:
            return False
        min_val = min(right, right2)
        max_val = max(right, right2)
        return left >= min_val - 1e-9 and left <= max_val + 1e-9
    
    if right is None:
        return False
    
    if op == Operator.EQ:
        return abs(left - right) < 1e-9
    if op == Operator.NEQ:
        return right is None or abs(left - right) >= 1e-9
    if op == Operator.GT:
        return left > right
    if op == Operator.GTE:
        return left >= right - 1e-9
    if op == Operator.LT:
        return left < right
    if op == Operator.LTE:
        return left <= right + 1e-9
    
    return False


def _eval_boolean_rule(raw: Any, op: str) -> bool:
    """Evaluate a boolean field rule."""
    bool_val = (
        raw is True
        or to_string(raw).lower() in ("true", "yes", "1")
        or raw == 1
    )
    
    if op == Operator.IS_TRUE:
        return bool_val
    if op == Operator.IS_FALSE:
        return not bool_val
    
    return False


def _eval_date_rule(
    raw: Any,
    rhs: Any,
    op: str,
    rule: Dict[str, Any],
    ctx: EvalContext,
) -> bool:
    """Evaluate a date field rule."""
    try:
        left_date = datetime.fromisoformat(to_string(raw))
    except (ValueError, TypeError):
        return False
    
    if op == Operator.WITHIN_LAST_DAYS:
        days = to_number(rhs)
        if days is None:
            return False
        cutoff = ctx.now - timedelta(days=days)
        return left_date >= cutoff
    
    try:
        right_date = datetime.fromisoformat(to_string(rhs))
    except (ValueError, TypeError):
        return False
    
    if op == Operator.EQ:
        return left_date.date() == right_date.date()
    if op == Operator.BEFORE:
        return left_date < right_date
    if op == Operator.AFTER:
        return left_date > right_date
    if op == Operator.BETWEEN:
        value2 = rule.get("value2")
        try:
            right2_date = datetime.fromisoformat(to_string(value2))
        except (ValueError, TypeError):
            return False
        min_date = min(right_date, right2_date)
        max_date = max(right_date, right2_date)
        return min_date <= left_date <= max_date
    
    return False


def _eval_text_rule(raw: Any, rhs: Any, op: str, field_type: str) -> bool:
    """Evaluate a text/select/user/group field rule."""
    left = to_string(raw).lower()
    right = to_string(rhs).lower()
    
    if op == Operator.EQ:
        return left == right
    if op == Operator.NEQ:
        return left != right
    if op == Operator.CONTAINS:
        return right in left
    if op == Operator.NOT_CONTAINS:
        return right not in left
    if op == Operator.STARTS_WITH:
        return left.startswith(right)
    if op == Operator.ENDS_WITH:
        return left.endswith(right)
    
    # Handle IN/NOT_IN for select/user/group
    if op in (Operator.IN, Operator.NOT_IN):
        right_list = to_list(rhs)
        matches = left in [r.lower() for r in right_list]
        return matches if op == Operator.IN else not matches
    
    return False


def _eval_multiselect_rule(raw: Any, rhs: Any, op: str) -> bool:
    """Evaluate a multiselect field rule."""
    left_list = to_list(raw)
    right_list = to_list(rhs)
    
    left_set = set(v.lower() for v in left_list)
    right_set = set(v.lower() for v in right_list)
    
    if op == Operator.CONTAINS_ANY:
        return bool(left_set & right_set)
    if op == Operator.CONTAINS_ALL:
        return right_set.issubset(left_set)
    
    return False


# ─────────────────────────────────────────────────────────────────────────────
# Group Evaluation
# ─────────────────────────────────────────────────────────────────────────────

def eval_group(
    group: Dict[str, Any],
    field_map: Dict[str, Dict[str, Any]],
    ctx: EvalContext,
) -> bool:
    """
    Evaluate a condition group (AND/OR with optional NOT).
    
    Args:
        group: Group dict with keys: combinator (and/or), negate (bool), children
        field_map: Map of field_id to field metadata
        ctx: Evaluation context
    
    Returns:
        True if the group matches, False otherwise.
    """
    combinator = group.get("combinator", "and")
    negate = group.get("negate", False)
    children = group.get("children", [])
    
    if not children:
        # Empty group never matches
        return False
    
    results = []
    for child in children:
        if child.get("kind") == "group":
            result = eval_group(child, field_map, ctx)
        else:
            result = eval_rule(child, field_map, ctx)
        results.append(result)
    
    if combinator == "and":
        group_result = all(results)
    else:  # or
        group_result = any(results)
    
    return not group_result if negate else group_result


# ─────────────────────────────────────────────────────────────────────────────
# Validation
# ─────────────────────────────────────────────────────────────────────────────

class ValidationError:
    """Represents a validation error or warning."""
    
    def __init__(
        self,
        severity: str,  # "error" or "warning"
        message: str,
        block_id: Optional[str] = None,
    ):
        self.severity = severity
        self.message = message
        self.block_id = block_id


def validate_definition(
    definition: Dict[str, Any],
    field_map: Dict[str, Dict[str, Any]],
    step_validator: Optional[callable] = None,
) -> List[ValidationError]:
    """
    Validate a workflow definition.
    
    Args:
        definition: Workflow definition dict with version and blocks
        field_map: Map of field_id to field metadata
        step_validator: Optional function to validate step data
    
    Returns:
        List of validation errors/warnings
    """
    errors: List[ValidationError] = []
    
    if not definition or definition.get("version") != 2:
        errors.append(ValidationError("error", "Invalid workflow definition version. Expected version 2."))
        return errors
    
    blocks = definition.get("blocks", [])
    
    # Check for at least one approval step
    def has_approval(blocks_list: List[Dict[str, Any]]) -> bool:
        for block in blocks_list:
            if block.get("kind") in ("approval", "notification"):
                return True
            if block.get("kind") in ("if_else", "switch"):
                for child_list in _get_child_blocks(block):
                    if has_approval(child_list):
                        return True
        return False
    
    if not has_approval(blocks):
        errors.append(ValidationError("error", "Workflow must have at least one approval step."))
    
    # Validate each block
    for block in blocks:
        block_errors = _validate_block(block, field_map, step_validator)
        errors.extend(block_errors)
    
    return errors


def _get_child_blocks(block: Dict[str, Any]) -> List[List[Dict[str, Any]]]:
    """Get all child block lists from a block."""
    kind = block.get("kind")
    if kind == "if_else":
        branches = block.get("branches", [])
        child_lists = [b.get("blocks", []) for b in branches]
        child_lists.append(block.get("else_blocks", []))
        return child_lists
    elif kind == "switch":
        cases = block.get("cases", [])
        child_lists = [c.get("blocks", []) for c in cases]
        child_lists.append(block.get("default_blocks", []))
        return child_lists
    return []


def _validate_block(
    block: Dict[str, Any],
    field_map: Dict[str, Dict[str, Any]],
    step_validator: Optional[callable],
) -> List[ValidationError]:
    """Validate a single block."""
    errors: List[ValidationError] = []
    kind = block.get("kind")
    block_id = block.get("id")
    
    if not kind:
        errors.append(ValidationError("error", "Block missing 'kind' field.", block_id))
        return errors
    
    if kind in ("approval", "notification"):
        step = block.get("step")
        if not step:
            errors.append(ValidationError("error", f"{kind} block missing step data.", block_id))
        elif step_validator:
            step_error = step_validator(step)
            if step_error:
                errors.append(ValidationError("error", step_error, block_id))
    
    elif kind == "if_else":
        branches = block.get("branches", [])
        if not branches:
            errors.append(ValidationError("error", "If/Else block must have at least one branch.", block_id))
        
        for branch in branches:
            when = branch.get("when")
            if not when:
                errors.append(ValidationError("error", "If/Else branch missing condition.", block_id))
            else:
                condition_errors = _validate_condition(when, field_map, block_id)
                errors.extend(condition_errors)
            
            # Recursively validate child blocks
            for child in branch.get("blocks", []):
                errors.extend(_validate_block(child, field_map, step_validator))
        
        # Validate else blocks
        for child in block.get("else_blocks", []):
            errors.extend(_validate_block(child, field_map, step_validator))
    
    elif kind == "switch":
        field_id = block.get("field_id")
        if not field_id:
            errors.append(ValidationError("error", "Switch block missing field_id.", block_id))
        elif field_id not in field_map:
            errors.append(ValidationError("warning", f"Switch references unknown field: {field_id}", block_id))
        
        cases = block.get("cases", [])
        if not cases:
            errors.append(ValidationError("error", "Switch block must have at least one case.", block_id))
        
        for case in cases:
            if not case.get("values"):
                errors.append(ValidationError("warning", "Switch case has no values.", block_id))
            
            # Recursively validate child blocks
            for child in case.get("blocks", []):
                errors.extend(_validate_block(child, field_map, step_validator))
        
        # Validate default blocks
        for child in block.get("default_blocks", []):
            errors.extend(_validate_block(child, field_map, step_validator))
    
    elif kind == "set_value":
        variable = block.get("variable")
        if not variable:
            errors.append(ValidationError("error", "Set variable block missing variable name.", block_id))
    
    elif kind == "end":
        outcome = block.get("outcome")
        if outcome not in ("approved", "rejected"):
            errors.append(ValidationError("error", f"End block has invalid outcome: {outcome}", block_id))
    
    else:
        errors.append(ValidationError("error", f"Unknown block kind: {kind}", block_id))
    
    return errors


def _validate_condition(
    condition: Dict[str, Any],
    field_map: Dict[str, Dict[str, Any]],
    block_id: Optional[str],
) -> List[ValidationError]:
    """Validate a condition (group or rule)."""
    errors: List[ValidationError] = []
    
    if condition.get("kind") == "group":
        children = condition.get("children", [])
        if not children:
            errors.append(ValidationError("error", "Empty condition group never matches.", block_id))
        
        for child in children:
            errors.extend(_validate_condition(child, field_map, block_id))
    
    else:  # rule
        field_id = condition.get("field_id")
        op = condition.get("op")
        
        if not field_id:
            errors.append(ValidationError("error", "Rule missing field_id.", block_id))
        elif field_id not in field_map:
            errors.append(ValidationError("warning", f"Rule references unknown field: {field_id}", block_id))
        
        if not op:
            errors.append(ValidationError("error", "Rule missing operator.", block_id))
    
    return errors


# ─────────────────────────────────────────────────────────────────────────────
# Graph Compilation and Execution
# ─────────────────────────────────────────────────────────────────────────────

class GraphNode:
    """A node in the compiled execution graph."""
    
    def __init__(
        self,
        node_id: str,
        block: Dict[str, Any],
        next_node_id: Optional[str] = None,
    ):
        self.node_id = node_id
        self.block = block
        self.next_node_id = next_node_id


class ExecutionResult:
    """Result of executing a workflow definition."""
    
    def __init__(
        self,
        outcome: str,  # "approved", "rejected", "pending_approvals", "no_approvers"
        chain: List[Dict[str, Any]],  # Steps in order of execution
        decisions: List[Dict[str, Any]],  # Branch decisions made
        warnings: List[str],
    ):
        self.outcome = outcome
        self.chain = chain
        self.decisions = decisions
        self.warnings = warnings


def compile_to_graph(definition: Dict[str, Any]) -> Tuple[Dict[str, GraphNode], str]:
    """
    Compile a workflow definition into an execution graph.
    
    Args:
        definition: Workflow definition with version and blocks
    
    Returns:
        Tuple of (node_id -> GraphNode mapping, root_node_id)
    """
    if not definition or definition.get("version") != 2:
        raise ValueError("Invalid workflow definition version")
    
    blocks = definition.get("blocks", [])
    nodes: Dict[str, GraphNode] = {}
    
    def compile_blocks(
        blocks_list: List[Dict[str, Any]],
        parent_next: Optional[str] = None,
    ) -> Optional[str]:
        """Compile a list of blocks and return the first node ID."""
        if not blocks_list:
            return parent_next
        
        first_id = None
        prev_id = None
        
        for i, block in enumerate(blocks_list):
            node_id = block.get("id") or f"node_{len(nodes)}"
            is_last = i == len(blocks_list) - 1
            next_id = parent_next if is_last else None
            
            nodes[node_id] = GraphNode(node_id, block, next_id)
            
            if prev_id:
                nodes[prev_id].next_node_id = node_id
            
            prev_id = node_id
            if first_id is None:
                first_id = node_id
            
            # Handle nested blocks (if_else, switch)
            kind = block.get("kind")
            if kind == "if_else":
                branch_first_ids = []
                for branch in block.get("branches", []):
                    branch_id = compile_blocks(branch.get("blocks", []), node_id)
                    if branch_id:
                        branch_first_ids.append(branch_id)
                
                else_id = compile_blocks(block.get("else_blocks", []), node_id)
                if else_id:
                    branch_first_ids.append(else_id)
                
                # Store branch entry points in the node for runtime resolution
                nodes[node_id].block["_branch_entry_ids"] = branch_first_ids
            
            elif kind == "switch":
                case_first_ids = []
                for case in block.get("cases", []):
                    case_id = compile_blocks(case.get("blocks", []), node_id)
                    if case_id:
                        case_first_ids.append(case_id)
                
                default_id = compile_blocks(block.get("default_blocks", []), node_id)
                if default_id:
                    case_first_ids.append(default_id)
                
                nodes[node_id].block["_case_entry_ids"] = case_first_ids
        
        return first_id
    
    root_id = compile_blocks(blocks)
    
    if not root_id:
        raise ValueError("Workflow definition has no blocks")
    
    return nodes, root_id


def simulate(
    definition: Dict[str, Any],
    field_map: Dict[str, Dict[str, Any]],
    values: Dict[str, Any],
    rates: Optional[Dict[str, float]] = None,
) -> ExecutionResult:
    """
    Simulate execution of a workflow definition with given values.
    
    Args:
        definition: Workflow definition
        field_map: Field metadata map
        values: Field values for simulation
        rates: Optional currency exchange rates
    
    Returns:
        ExecutionResult with outcome, chain, decisions, and warnings
    """
    try:
        nodes, root_id = compile_to_graph(definition)
    except ValueError as e:
        return ExecutionResult(
            outcome="no_approvers",
            chain=[],
            decisions=[],
            warnings=[str(e)],
        )
    
    ctx = EvalContext(values=values, rates=rates)
    chain: List[Dict[str, Any]] = []
    decisions: List[Dict[str, Any]] = []
    visited: Set[str] = set()
    
    current_id = root_id
    
    while current_id:
        if current_id in visited:
            # Avoid infinite loops
            decisions.append({
                "block_id": current_id,
                "kind": "loop",
                "matched_label": "detected cycle",
            })
            break
        
        visited.add(current_id)
        node = nodes.get(current_id)
        
        if not node:
            break
        
        block = node.block
        kind = block.get("kind")
        
        if kind in ("approval", "notification"):
            # Add to chain - these are actual steps that need execution
            chain.append({
                "id": block.get("id"),
                "kind": kind,
                "step": block.get("step"),
            })
        
        elif kind == "if_else":
            # Evaluate branches in order, first match wins
            branches = block.get("branches", [])
            matched = False
            matched_label = None
            
            for branch in branches:
                when = branch.get("when")
                if eval_group(when, field_map, ctx):
                    matched = True
                    matched_label = branch.get("label") or f"Branch {branch.get('id')}"
                    # Jump to first block in this branch
                    branch_ids = block.get("_branch_entry_ids", [])
                    if branch_ids:
                        branch_index = branches.index(branch)
                        if branch_index < len(branch_ids):
                            current_id = branch_ids[branch_index]
                    break
            
            if not matched:
                # Use else branch
                else_blocks = block.get("else_blocks", [])
                if else_blocks:
                    matched_label = "ELSE (fallback)"
                    branch_ids = block.get("_branch_entry_ids", [])
                    if branch_ids:
                        current_id = branch_ids[-1]
                else:
                    # No else, move to next node
                    current_id = node.next_node_id
            
            decisions.append({
                "block_id": block.get("id"),
                "kind": "if_else",
                "matched_label": matched_label or "no match",
            })
            
            if not matched and not else_blocks:
                current_id = node.next_node_id
            continue
        
        elif kind == "switch":
            field_id = block.get("field_id")
            field_value = get_value(ctx, field_id)
            field_value_str = to_string(field_value)
            
            matched = False
            matched_label = None
            
            # Check cases
            cases = block.get("cases", [])
            for case in cases:
                case_values = case.get("values", [])
                if field_value_str in [to_string(v) for v in case_values]:
                    matched = True
                    matched_label = case.get("label") or f"Case {case.get('id')}"
                    case_ids = block.get("_case_entry_ids", [])
                    case_index = cases.index(case)
                    if case_index < len(case_ids):
                        current_id = case_ids[case_index]
                    break
            
            if not matched:
                # Use default
                default_blocks = block.get("default_blocks", [])
                if default_blocks:
                    matched_label = "DEFAULT"
                    case_ids = block.get("_case_entry_ids", [])
                    if case_ids:
                        current_id = case_ids[-1]
                else:
                    current_id = node.next_node_id
            
            decisions.append({
                "block_id": block.get("id"),
                "kind": "switch",
                "matched_label": matched_label or "no match",
            })
            
            if not matched and not default_blocks:
                current_id = node.next_node_id
            continue
        
        elif kind == "set_value":
            variable = block.get("variable")
            value = block.get("value")
            value_ref = block.get("value_ref")
            
            if variable:
                if value_ref:
                    ctx.vars[variable] = get_value(ctx, value_ref)
                else:
                    ctx.vars[variable] = value
        
        elif kind == "end":
            outcome = block.get("outcome")
            reason = block.get("reason", "")
            
            if outcome == "approved":
                return ExecutionResult(
                    outcome="auto_approved",
                    chain=chain,
                    decisions=decisions,
                    warnings=ctx.warnings,
                )
            else:
                return ExecutionResult(
                    outcome="auto_rejected",
                    chain=chain,
                    decisions=decisions,
                    warnings=ctx.warnings,
                )
        
        # Move to next node
        current_id = node.next_node_id
    
    # Determine final outcome
    if chain:
        return ExecutionResult(
            outcome="pending_approvals",
            chain=chain,
            decisions=decisions,
            warnings=ctx.warnings,
        )
    else:
        return ExecutionResult(
            outcome="no_approvers",
            chain=chain,
            decisions=decisions,
            warnings=ctx.warnings + ["Workflow has no approval steps"],
        )


def flatten_steps(definition: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Flatten a workflow definition into a linear list of steps.
    
    This is used to maintain backward compatibility with the flat `steps`
    field for list views and step_count calculations.
    
    Args:
        definition: Workflow definition
    
    Returns:
        Linear list of approval/notification steps in document order
    """
    if not definition or definition.get("version") != 2:
        return []
    
    blocks = definition.get("blocks", [])
    steps: List[Dict[str, Any]] = []
    
    def walk_blocks(blocks_list: List[Dict[str, Any]]):
        for block in blocks_list:
            kind = block.get("kind")
            if kind in ("approval", "notification"):
                steps.append(block.get("step", {}))
            elif kind in ("if_else", "switch"):
                for branch in block.get("branches", []):
                    walk_blocks(branch.get("blocks", []))
                walk_blocks(block.get("else_blocks", []))
                for case in block.get("cases", []):
                    walk_blocks(case.get("blocks", []))
                walk_blocks(block.get("default_blocks", []))
    
    walk_blocks(blocks)
    return steps


def resolve_active_path(
    definition: Dict[str, Any],
    field_map: Optional[Dict[str, Dict[str, Any]]] = None,
    context: Optional[Dict[str, Any]] = None,
) -> Tuple[List[int], Optional[str]]:
    """Resolve which steps a v2 definition actually executes for *context*.

    A v2 definition is a graph: ``if_else`` chooses a branch and ``switch``
    chooses a case.  The flat ``WorkflowStep`` mirror, however, is built by
    :func:`flatten_steps`, which appends *every* branch in document order.  So a
    fresh instance must not start at mirror order 1 — it must start at the first
    step of the branch/case that matches the evaluation context (e.g. the
    ``requisition`` case for a new requisition, not ``lpo``).

    Returns ``(orders, end_outcome)`` where *orders* are 1-based positions
    aligned with :func:`flatten_steps` (and therefore ``WorkflowStep.order``).
    Non-taken branches are still counted so positions line up, but only the
    taken path's steps are returned.  *end_outcome* is set when the taken path
    reaches an ``end`` block (e.g. the switch default).
    """
    if not definition or definition.get("version") != 2:
        return [], None

    field_map = field_map or {}
    ctx = EvalContext(values=context or {}, vars={}, rates={})
    counter = [0]
    orders: List[int] = []
    end_outcome: List[Optional[str]] = [None]

    def walk(blocks_list: Optional[List[Dict[str, Any]]], active: bool) -> None:
        for block in blocks_list or []:
            kind = block.get("kind")
            if kind in ("approval", "notification"):
                counter[0] += 1
                if active:
                    orders.append(counter[0])
            elif kind == "if_else":
                branches = block.get("branches", [])
                matched_index = None
                for index, branch in enumerate(branches):
                    try:
                        if eval_group(branch.get("when"), field_map, ctx):
                            matched_index = index
                            break
                    except Exception:
                        continue
                for index, branch in enumerate(branches):
                    walk(branch.get("blocks", []), active and index == matched_index)
                walk(block.get("else_blocks", []), active and matched_index is None)
            elif kind == "switch":
                field_value = to_string(get_value(ctx, block.get("field_id")))
                cases = block.get("cases", [])
                matched_index = None
                for index, case in enumerate(cases):
                    if field_value in [to_string(value) for value in case.get("values", [])]:
                        matched_index = index
                        break
                for index, case in enumerate(cases):
                    walk(case.get("blocks", []), active and index == matched_index)
                walk(block.get("default_blocks", []), active and matched_index is None)
            elif kind == "end":
                if active and not end_outcome[0]:
                    end_outcome[0] = block.get("outcome")

    walk(definition.get("blocks", []), True)
    return orders, end_outcome[0]


# ─────────────────────────────────────────────────────────────────────────────
# Runtime Execution (for actual workflow instances)
# ─────────────────────────────────────────────────────────────────────────────

class WorkflowExecution:
    """
    Runtime execution of a v2 workflow definition.
    
    This class handles the actual execution of a workflow for a document or payment run,
    traversing the graph and creating tasks as needed.
    """
    
    def __init__(
        self,
        definition: Dict[str, Any],
        field_map: Dict[str, Dict[str, Any]],
        context: Dict[str, Any],
        rates: Optional[Dict[str, float]] = None,
    ):
        self.definition = definition
        self.field_map = field_map
        self.context = context
        self.rates = rates or {}
        self.ctx = EvalContext(values=context, vars={}, rates=rates)
        
        # Compile the graph
        self.nodes, self.root_id = compile_to_graph(definition)
        
        # Execution state
        self.current_node_id = self.root_id
        self.execution_path: List[str] = []
        self.decisions: List[Dict[str, Any]] = []
        self.completed = False
        self.outcome: Optional[str] = None  # "approved", "rejected"
        self.warnings: List[str] = []
    
    def get_next_block(self) -> Optional[Dict[str, Any]]:
        """
        Get the next block to execute.
        
        Returns:
            The next block dict, or None if workflow is complete
        """
        if self.completed or not self.current_node_id:
            return None
        
        node = self.nodes.get(self.current_node_id)
        if not node:
            return None
        
        return node.block
    
    def advance(self, decision_data: Optional[Dict[str, Any]] = None) -> bool:
        """
        Advance to the next node in the execution graph.
        
        Args:
            decision_data: Optional data about the decision made (for if_else/switch)
        
        Returns:
            True if advanced successfully, False if workflow is complete
        """
        if self.completed or not self.current_node_id:
            return False
        
        node = self.nodes.get(self.current_node_id)
        if not node:
            self.completed = True
            return False
        
        block = node.block
        kind = block.get("kind")
        
        # Record the current node in execution path
        self.execution_path.append(self.current_node_id)
        
        if kind in ("approval", "notification"):
            # Move to next node after step execution
            self.current_node_id = node.next_node_id
            return True
        
        elif kind == "if_else":
            # Evaluate branches
            branches = block.get("branches", [])
            matched = False
            matched_branch_id = None
            
            for branch in branches:
                when = branch.get("when")
                if eval_group(when, self.field_map, self.ctx):
                    matched = True
                    matched_branch_id = branch.get("id")
                    # Find the entry point for this branch
                    branch_ids = block.get("_branch_entry_ids", [])
                    branch_index = branches.index(branch)
                    if branch_index < len(branch_ids):
                        self.current_node_id = branch_ids[branch_index]
                    break
            
            if not matched:
                # Use else branch
                else_blocks = block.get("else_blocks", [])
                if else_blocks:
                    matched_branch_id = "else"
                    branch_ids = block.get("_branch_entry_ids", [])
                    if branch_ids:
                        self.current_node_id = branch_ids[-1]
                else:
                    # No else, move to next node
                    self.current_node_id = node.next_node_id
            
            self.decisions.append({
                "block_id": block.get("id"),
                "kind": "if_else",
                "matched_slot": matched_branch_id or "none",
                "matched_label": decision_data.get("label") if decision_data else None,
            })
            
            if not matched and not else_blocks:
                self.current_node_id = node.next_node_id
            return True
        
        elif kind == "switch":
            field_id = block.get("field_id")
            field_value = get_value(self.ctx, field_id)
            field_value_str = to_string(field_value)
            
            matched = False
            matched_case_id = None
            
            # Check cases
            cases = block.get("cases", [])
            for case in cases:
                case_values = case.get("values", [])
                if field_value_str in [to_string(v) for v in case_values]:
                    matched = True
                    matched_case_id = case.get("id")
                    case_ids = block.get("_case_entry_ids", [])
                    case_index = cases.index(case)
                    if case_index < len(case_ids):
                        self.current_node_id = case_ids[case_index]
                    break
            
            if not matched:
                # Use default
                default_blocks = block.get("default_blocks", [])
                if default_blocks:
                    matched_case_id = "default"
                    case_ids = block.get("_case_entry_ids", [])
                    if case_ids:
                        self.current_node_id = case_ids[-1]
                else:
                    self.current_node_id = node.next_node_id
            
            self.decisions.append({
                "block_id": block.get("id"),
                "kind": "switch",
                "matched_slot": matched_case_id or "none",
                "matched_label": decision_data.get("label") if decision_data else None,
            })
            
            if not matched and not default_blocks:
                self.current_node_id = node.next_node_id
            return True
        
        elif kind == "set_value":
            variable = block.get("variable")
            value = block.get("value")
            value_ref = block.get("value_ref")
            
            if variable:
                if value_ref:
                    self.ctx.vars[variable] = get_value(self.ctx, value_ref)
                else:
                    self.ctx.vars[variable] = value
            
            # Move to next node
            self.current_node_id = node.next_node_id
            return True
        
        elif kind == "end":
            outcome = block.get("outcome")
            self.outcome = outcome
            self.completed = True
            return False
        
        # Move to next node
        self.current_node_id = node.next_node_id
        return self.current_node_id is not None
    
    def get_execution_summary(self) -> Dict[str, Any]:
        """
        Get a summary of the execution for audit logging.
        
        Returns:
            Dict with execution path, decisions, warnings, and outcome
        """
        return {
            "execution_path": self.execution_path,
            "decisions": self.decisions,
            "warnings": self.ctx.warnings,
            "outcome": self.outcome,
            "completed": self.completed,
        }
