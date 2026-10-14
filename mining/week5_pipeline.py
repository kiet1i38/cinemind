"""Pure assembly of snapshot components shared by replay and ranking CLIs."""

from user_behavior_features import build_candidate_features


def query_components(snapshot, content_context, cluster_bundle=None, tree_bundle=None):
    from build_user_clusters import assign_clusters
    from pre_rec_tree import predict_liked
    from ranking_scores import candidate_pool, content_scores, popularity_scores
    assignments = assign_clusters(snapshot, cluster_bundle) if cluster_bundle else []
    clusters = {row["user_key"]: row["cluster_id"] for row in assignments if row["cluster_id"] is not None}
    popularity = popularity_scores(snapshot)
    output = {}
    for user in sorted(snapshot["users"]):
        ids = candidate_pool(snapshot, user)
        content = content_scores(snapshot, user, content_context)
        cluster = None
        if user in clusters and snapshot["cohort"] == "synthetic" and cluster_bundle.get("signal_eligible"):
            members = [key for key, label in clusters.items() if label == clusters[user]]
            cluster = popularity_scores(snapshot, members)
        tree = None
        if tree_bundle and snapshot["cohort"] == "synthetic" and content is not None:
            features = build_candidate_features(snapshot, user, ids, content)
            probabilities = predict_liked(tree_bundle, [features[sid] for sid in ids])
            tree = dict(zip(ids, probabilities)) if probabilities is not None else None
        output[user] = {"candidate_ids": ids, "C": content, "P": popularity, "T": tree, "K": cluster}
    return output


def rank_queries(snapshot, components, weights, algorithm="hybrid"):
    from ranking_scores import rank_candidates
    chosen = weights if algorithm == "hybrid" else {"C": float(algorithm == "content"),
              "P": float(algorithm == "popularity"), "T": 0., "K": 0.}
    return {user: rank_candidates(values["candidate_ids"], values, chosen,
                 bool(snapshot["users"][user]["liked_ids"])) for user, values in components.items()}


def target_features(snapshot, targets, content_context):
    from ranking_scores import content_scores
    by_user = {}
    for row in targets:
        by_user.setdefault(row["user_key"], []).append(row)
    rows = []
    for user, group in sorted(by_user.items()):
        content = content_scores(snapshot, user, content_context)
        features = build_candidate_features(snapshot, user, [row["show_id"] for row in group], content or {})
        rows.extend({**target, **features[target["show_id"]]} for target in group)
    return rows
