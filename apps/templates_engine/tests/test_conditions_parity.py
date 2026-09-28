"""Parity tests: the Python calculation + rule engine must agree with the
frontend engine (lib/calculations.ts, lib/ruleOperators.ts).

calc_vectors.json / calc_expected.json hold the vectors and the results the TS
engine produced for them (regenerate expected with calc_vectors.test.ts).
Run:  pytest apps/templates_engine/tests/test_conditions_parity.py
"""
import copy
import json
import pathlib

from apps.templates_engine import conditions as c

HERE = pathlib.Path(__file__).parent


def _same(a, b):
    if isinstance(a, str) or isinstance(b, str):
        try:
            return abs(float(a) - float(b)) < 1e-9
        except (TypeError, ValueError):
            return a == b
    return abs(float(a) - float(b)) < 1e-9 * max(1, abs(float(a)))


def test_calc_engine_matches_frontend():
    d = json.loads((HERE / "calc_vectors.json").read_text())
    exp = json.loads((HERE / "calc_expected.json").read_text())
    sections = [{"fields": d["fields"] + [d["table"]] + [
        {"key": k["id"], "type": k["type"],
         "calc": {"expression": k["expr"], **({"decimals": k["decimals"]} if k["decimals"] is not None else {})}}
        for k in d["cases"]]}]
    out = c.compute_calculated_values(sections, copy.deepcopy(d["values"]))
    for k in d["cases"]:
        a, b = exp["fields"][k["id"]], out[k["id"]]
        if isinstance(a, str) and isinstance(b, str):
            assert a == b, (k["expr"], a, b)
        else:
            assert not isinstance(a, str) and not isinstance(b, str) and _same(a, b), (k["expr"], a, b)
    for tr, pr in zip(exp["table"], out["expenses"]):
        for col in d["table"]["columns"]:
            assert _same(tr.get(col["key"], ""), pr.get(col["key"], "")) or tr.get(col["key"]) == pr.get(col["key"])


def test_operators_match_frontend():
    cases = json.loads((HERE / "op_cases.json").read_text())
    exp = json.loads((HERE / "op_expected.json").read_text())
    for (op, sv, expected), want in zip(cases, exp):
        assert c.match_operator(op, sv, expected) is want, (op, sv, expected)


def test_nested_groups_and_row_semantics():
    g = {"combinator": "and",
         "conditions": [{"source": "field", "fieldKey": "x.amt", "operator": "greater_than", "value": "100"}],
         "groups": [{"combinator": "or", "conditions": [
             {"source": "process_step", "operator": "equals", "value": "draft"},
             {"source": "field", "fieldKey": "cat", "operator": "in_list", "value": "a,b"}]}]}
    assert c.eval_group(g, {"x": [{"amt": "50"}, {"amt": "150"}], "cat": "z"}, "draft") is True
    assert c.eval_group(g, {"x": [{"amt": "50"}], "cat": "a"}, "draft") is False
    assert c.eval_group(g, {"x": [{"amt": "150"}], "cat": "z"}, "approved") is False
    assert c.eval_group({"combinator": "and", "conditions": [], "groups": [{"conditions": []}]}, {}, "draft") is True
    assert c.eval_group({"fieldKey": "n", "operator": "less_than", "value": "10"}, {"n": "3"}, "draft") is True


def test_bad_formulas_never_raise():
    for expr in ["NOSUCHFN(1)", "1 +", "IF(1, 2)", "ROUND()", "((((", "1 / 0", '"unterminated']:
        assert c.evaluate_calc_expression(expr, {}) in (0, 0.0)