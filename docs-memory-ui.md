# Memory library interface

The approved layout uses a category sidebar, a compact index and an inline reading pane on desktop. Below 900px the same detail content moves to a modal, avoiding duplicate IDs or hidden copies of private record text. Below 600px categories become direct tabs. Existing authentication, OAuth, token and password flows remain in the account menu.

The default category is episodes. Preferences and agreements share a paginated database query; dreams and reflections search only when that category is explicitly selected. List metadata includes stored title/summary only, not all evidence quotations. Missing metadata falls back to a literal excerpt; missing event dates remain unknown. Month groups explicitly refer to collection/recording dates.

Correction carries source evidence forward, permits a new type/title/summary and retains the version chain. Withdrawal requires a reason. Source identifiers and historic versions appear in expandable detail sections. No existing production record is automatically reclassified or rewritten by the UI update.

Vesper iOS uses the same categories, a compact 12-point semantic caption for summaries, 7-point card spacing, pinned search and bottom navigation clearance. It reads actual acknowledged deliveries from `/api/memory/context` only when Recent resurfacing is expanded. The standalone Memory service has no binding to the Vesper recall ledger, so its panel directs the user to Vesper instead of inventing delivery history.

Coordinated backend change: `/api/memories` and `/api/search` accept `kind=preference_agreement`, and list/search results carry `details.title` and `details.summary`. Original APIs and individual kinds remain supported.
