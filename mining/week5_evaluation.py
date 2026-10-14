"""Temporal benchmark gates and deterministic validation weight selection."""

from datetime import timedelta
from itertools import product

from preference_features import parse_time


def window_contract(source, train, validation, test):
    times = [parse_time(value, name) if isinstance(value, str) else value
             for name, value in zip(("train", "validation", "test"), (train, validation, test))]
    if not times[0] < times[1] < times[2]:
        raise ValueError("train < validation < test cutoffs are required")
    ends = [value + timedelta(days=7) for value in times]
    if ends[0] > times[1] or ends[1] > times[2]:
        raise ValueError("seven-day outcome windows must not overlap")
    coverage = source.get("coverage") or {}
    start, end = coverage.get("observation_start"), coverage.get("observation_end")
    known = bool(start and end)
    complete = known and parse_time(start, "observation_start") <= times[0] and parse_time(end, "observation_end") >= ends[2]
    return times, ends, {"coverage_known": known, "complete_outcomes": bool(complete),
                         "observation_start": start, "observation_end": end,
                         "window_days": 7, "window_policy": "[cutoff, cutoff+7d)"}


def weight_grid():
    for content, popularity, tree in product(range(11), repeat=3):
        cluster = 10 - content - popularity - tree
        if cluster >= 0:
            yield dict(zip(("C", "P", "T", "K"),
                           (value / 10 for value in (content, popularity, tree, cluster))))


def select_weights(results):
    defined = [row for row in results if row["mean_ndcg10"] is not None]
    if not defined:
        return None
    def order(row):
        weights = row["weights"]
        return (-row["mean_ndcg10"], sum(value > 0 for value in weights.values()),
                *(-weights[key] for key in ("C", "P", "T", "K")))
    return min(defined, key=order)


def self_check():
    source = {"coverage": {"observation_start": "2026-07-01T00:00:00Z",
                            "observation_end": "2026-08-22T00:00:00Z"}}
    dates = ("2026-08-01T00:00:00Z", "2026-08-08T00:00:00Z", "2026-08-15T00:00:00Z")
    assert window_contract(source, *dates)[2]["complete_outcomes"]
    assert not window_contract({}, *dates)[2]["coverage_known"]
    for bad in ((dates[0], dates[0], dates[2]), (dates[0], "2026-08-07T00:00:00Z", dates[2])):
        try:
            window_contract(source, *bad)
        except ValueError:
            continue
        raise AssertionError("invalid windows accepted")
    grid = list(weight_grid())
    assert len(grid) == 286 and all(abs(sum(row.values()) - 1) < 1e-12 for row in grid)
    tied = [{"weights": row, "mean_ndcg10": 0.2} for row in grid]
    assert select_weights(tied)["weights"] == {"C": 1., "P": 0., "T": 0., "K": 0.}
    print("self-check ok: seven-day windows, coverage, 286-grid deterministic ties")
