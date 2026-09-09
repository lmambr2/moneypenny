// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Light RAG / org-memory eval loop (Node `bot/src/rag/eval-loop.ts`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvalExpect {
    Doctrine,
    OrgMemory,
    Either,
    Both,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalCase {
    pub id: String,
    pub query: String,
    pub expect: EvalExpect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect_includes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_doctrine_hits: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_org_hits: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalHit {
    pub text: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub classification: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalCaseResult {
    pub id: String,
    pub query: String,
    pub pass: bool,
    pub doctrine_hits: u32,
    pub org_hits: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub samples: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalAxes {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retrieval_precision: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported_claim_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub injection_dedup_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalReport {
    pub ok: bool,
    pub passed: u32,
    pub failed: u32,
    pub results: Vec<EvalCaseResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub axes: Option<EvalAxes>,
}

pub fn compute_memory_axes(
    gold_hits: Option<u32>,
    top_k_hits: Option<u32>,
    unsupported_claims: Option<u32>,
    total_claims: Option<u32>,
    skipped_dedup: Option<u32>,
    candidates: Option<u32>,
    latency_ms: Option<f64>,
) -> EvalAxes {
    let mut axes = EvalAxes {
        retrieval_precision: None,
        unsupported_claim_rate: None,
        injection_dedup_rate: None,
        latency_ms,
    };
    if let (Some(gold), Some(top)) = (gold_hits, top_k_hits) {
        if top > 0 {
            axes.retrieval_precision = Some(f64::from(gold) / f64::from(top));
        }
    }
    if let Some(total) = total_claims {
        if total > 0 {
            axes.unsupported_claim_rate = Some(f64::from(unsupported_claims.unwrap_or(0)) / f64::from(total));
        }
    }
    if let Some(cand) = candidates {
        if cand > 0 {
            axes.injection_dedup_rate = Some(f64::from(skipped_dedup.unwrap_or(0)) / f64::from(cand));
        }
    }
    axes
}

pub fn default_eval_cases() -> Vec<EvalCase> {
    vec![
        EvalCase {
            id: "doctrine-ops".into(),
            query: "ops briefing priorities".into(),
            expect: EvalExpect::Doctrine,
            expect_includes: None,
            min_doctrine_hits: Some(1),
            min_org_hits: None,
        },
        EvalCase {
            id: "doctrine-combat".into(),
            query: "combat doctrine engagement ROE".into(),
            expect: EvalExpect::Doctrine,
            expect_includes: None,
            min_doctrine_hits: Some(1),
            min_org_hits: None,
        },
        EvalCase {
            id: "org-fc".into(),
            query: "fleet commander".into(),
            expect: EvalExpect::OrgMemory,
            expect_includes: None,
            min_doctrine_hits: None,
            min_org_hits: Some(1),
        },
        EvalCase {
            id: "either-station".into(),
            query: "station welcome".into(),
            expect: EvalExpect::Either,
            expect_includes: None,
            min_doctrine_hits: None,
            min_org_hits: None,
        },
    ]
}

pub fn run_eval_case(
    c: &EvalCase,
    doctrine: &[EvalHit],
    org: &[String],
) -> EvalCaseResult {
    let doctrine_hits = doctrine.len() as u32;
    let org_hits = org.len() as u32;
    let mut samples: Vec<String> = doctrine
        .iter()
        .take(2)
        .map(|h| {
            let t: String = h.text.chars().take(80).collect();
            format!("[doc:{}] {t}", h.source)
        })
        .collect();
    samples.extend(org.iter().take(2).map(|f| {
        let t: String = f.chars().take(80).collect();
        format!("[org] {t}")
    }));

    let min_doc = c.min_doctrine_hits.unwrap_or(1);
    let min_org = c.min_org_hits.unwrap_or(1);
    let (mut pass, mut reason) = match c.expect {
        EvalExpect::Doctrine => {
            let ok = doctrine_hits >= min_doc;
            (
                ok,
                if ok {
                    None
                } else {
                    Some(format!("doctrine hits {doctrine_hits} < {min_doc}"))
                },
            )
        }
        EvalExpect::OrgMemory => {
            let ok = org_hits >= min_org;
            (
                ok,
                if ok {
                    None
                } else {
                    Some(format!("org hits {org_hits} < {min_org}"))
                },
            )
        }
        EvalExpect::Either => {
            let ok = doctrine_hits >= 1 || org_hits >= 1;
            (
                ok,
                if ok {
                    None
                } else {
                    Some("no doctrine or org hits".into())
                },
            )
        }
        EvalExpect::Both => {
            let ok = doctrine_hits >= min_doc && org_hits >= min_org;
            (
                ok,
                if ok {
                    None
                } else {
                    Some(format!("need both (doc={doctrine_hits}, org={org_hits})"))
                },
            )
        }
    };

    if pass {
        if let Some(needle) = c.expect_includes.as_deref() {
            let blob = doctrine
                .iter()
                .map(|h| format!("{}{}", h.text, h.source))
                .chain(org.iter().cloned())
                .collect::<Vec<_>>()
                .join("\n")
                .to_ascii_lowercase();
            if !blob.contains(&needle.to_ascii_lowercase()) {
                pass = false;
                reason = Some(format!("missing expected substring \"{needle}\""));
            }
        }
    }

    if pass && matches!(c.expect, EvalExpect::Doctrine) && doctrine.iter().all(|h| h.text.trim().is_empty())
    {
        pass = false;
        reason = Some("doctrine hits have empty text (empty rewrite risk)".into());
    }

    EvalCaseResult {
        id: c.id.clone(),
        query: c.query.clone(),
        pass,
        doctrine_hits,
        org_hits,
        reason,
        samples,
    }
}

pub fn run_eval_loop(cases: &[EvalCase], doctrine: &[Vec<EvalHit>], org: &[Vec<String>]) -> EvalReport {
    let mut results = Vec::new();
    for (i, c) in cases.iter().enumerate() {
        let d = doctrine.get(i).map(Vec::as_slice).unwrap_or(&[]);
        let o = org.get(i).map(Vec::as_slice).unwrap_or(&[]);
        results.push(run_eval_case(c, d, o));
    }
    let passed = results.iter().filter(|r| r.pass).count() as u32;
    let failed = results.len() as u32 - passed;
    EvalReport {
        ok: failed == 0,
        passed,
        failed,
        results,
        axes: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(text: &str, source: &str) -> EvalHit {
        EvalHit {
            text: text.into(),
            source: source.into(),
            score: Some(0.9),
            classification: Some("unclassified".into()),
        }
    }

    #[test]
    fn doctrine_pass_and_empty_fail() {
        let c = EvalCase {
            id: "d1".into(),
            query: "ops".into(),
            expect: EvalExpect::Doctrine,
            expect_includes: None,
            min_doctrine_hits: None,
            min_org_hits: None,
        };
        assert!(run_eval_case(&c, &[hit("Ops brief at 1900", "ops.md")], &[]).pass);
        let fail = run_eval_case(&c, &[], &[]);
        assert!(!fail.pass);
        assert!(fail.reason.as_deref().unwrap_or("").contains("doctrine hits"));
        let empty = run_eval_case(&c, &[hit("   ", "a.md")], &[]);
        assert!(!empty.pass);
        assert!(empty.reason.as_deref().unwrap_or("").to_ascii_lowercase().contains("empty"));
    }

    #[test]
    fn org_and_either() {
        let org = EvalCase {
            id: "o1".into(),
            query: "FC".into(),
            expect: EvalExpect::OrgMemory,
            expect_includes: None,
            min_doctrine_hits: None,
            min_org_hits: None,
        };
        assert!(run_eval_case(&org, &[hit("should not satisfy", "d.md")], &["FC is Alice".into()]).pass);
        let either = EvalCase {
            id: "e1".into(),
            query: "welcome".into(),
            expect: EvalExpect::Either,
            expect_includes: None,
            min_doctrine_hits: None,
            min_org_hits: None,
        };
        assert!(run_eval_case(&either, &[], &["welcome to station".into()]).pass);
    }

    #[test]
    fn default_loop_with_fixtures() {
        let cases = default_eval_cases();
        let doctrine: Vec<Vec<EvalHit>> = cases
            .iter()
            .map(|c| {
                if c.query.contains("combat") || c.query.contains("ops") || c.query.contains("station") {
                    vec![hit(&format!("hit for {}", c.query), "doc.md")]
                } else {
                    vec![]
                }
            })
            .collect();
        let org: Vec<Vec<String>> = cases
            .iter()
            .map(|c| {
                if c.query.contains("fleet") || c.query.contains("station") {
                    vec![format!("org fact {}", c.query)]
                } else {
                    vec![]
                }
            })
            .collect();
        let report = run_eval_loop(&cases, &doctrine, &org);
        assert!(report.ok);
        assert_eq!(report.failed, 0);
        assert_eq!(report.passed, cases.len() as u32);
    }
}
