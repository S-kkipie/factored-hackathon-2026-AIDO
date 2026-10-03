# Data audit — LATAM Bank (v1.0.0), 2026-10-02

Source: organizer S3 `data/` prefix, read with DuckDB over hive-partitioned CSVs.

## Row counts vs. documented
| table | documented | found | dup ids |
|---|---|---|---|
| call_center_interactions | 800,000 | 686,296 | 0 |
| call_transcripts | 200,000 | 171,321 | 0 |
| complaints | 80,000 | 67,095 | 0 |
| transactions | 5,000,000 | 4,425,008 | 0 |

## Contact demand (call_center_interactions)
| reason | share | FCR | avg duration s |
|---|---|---|---|
| Transaccional | 35.0% | 91.5% | 221 |
| Producto | 22.0% | 89.6% | 266 |
| Queja | 17.1% | 43.6% | 435 |
| Técnico | 15.0% | 69.9% | 360 |
| Comercial | 8.0% | 65.2% | 540 |
| Retención | 3.0% | 60.2% | 479 |

- `contact_reason` == `reason_category` (no finer granularity).
- Escalation ~10%, wait ~120 s, FCR flat across channel, segment, country, year, accent match → independent random fields.

## Complaints
- 5 subcategories at ~18% each: Cargo no reconocido, Cobro indebido, Problema con app, Atención en sucursal, Calidad de servicio.
- SLA breach ~20%, ~15.5 resolution days, satisfaction ~3.0 — flat across category, priority, channel.
- `description`: 5 distinct strings ("Queja relacionada con X"); 77% of `resolution` null, 5 templates.

## Transcripts
- 100% `es`; 0 Portuguese.
- 42 distinct `customer_text`, built from 2 openers (saldo tarjeta de crédito / saldo cuenta de ahorros) + filler phrases.
- Agent text contains unfilled placeholders (`{monto} {moneda}`).
- `main_topics` is a copy of the interaction `reason_category`; purity of label given text = 0.349 (chance) → labels unrelated to text. `detected_intents` = `consulta_general` 95%.

## Transactions
- is_fraud 0.10%, independent of type, channel, status, merchant category, foreign country.
- `fraud_score` ≥ 40 → is_fraud 100%; < 30 → 0.03% → label leaks through score; deterministic threshold, not a learning problem.

## Arrival lag
- `process_date` minus event date: avg −0.25 days, min −1, max 0 in every partitioned table → no real late arrivals; incremental-load correctness is demonstrated with a labeled test fixture (late partition + corrected row).
- Purchases and withdrawals are capped at USD 500 → synthetic auto-dispute limit set to USD 250.

## Implications
- Usable as evidence: contact mix by reason, complaint mix, FCR/duration gap of complaints, SLA/resolution time.
- Not usable for supervised NLP (intent labels random wrt text, 2 base intents).
- ML component must use team-generated, clearly labeled data with a held-out human-written set; Portuguese must be team-generated.
