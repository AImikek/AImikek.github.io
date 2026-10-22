# MikeK Admin hub

`/a/` is the central dashboard. Static files are hosted on the existing GitHub Pages site. The `hub` HTTP function is a separate Firebase codebase (`mikek-hub`) in the existing `referrals-55bee` project; deploy it without changing the existing `referrals` function:

    npm ci --prefix hub-api/functions
    npm test --prefix hub-api/functions
    firebase deploy --config hub-api/firebase.json --only functions:mikek-hub --project referrals-55bee

Owner authorization is enforced on the server with Firebase ID tokens from `mikek-tasks`, verified email status, and the two existing Tasks admin email addresses. The public homepage endpoint returns only published cards and follower text. Raw Firestore collections reject anonymous access. Logo uploads are raster images reduced to 128px in the browser, with format/size validation on the server. Draft edits are held only in memory until Publish; revision checks prevent silent overwrites. Published data is served within 30 seconds, with static HTML as an outage/no-JavaScript fallback.

The main hub reads Tasks using its existing Firebase rules. Referral activity is read by the backend from its own project. Pickleball uses the existing app and session in a same-origin frame, with a read-only owner-checked summary bridge. House Manager connects through its own admin-only `/admin/hub` popup and existing login. Its companion change lives in `AImikek/housemanager`. The browser sends only aggregate employee/shift/task counts and recent shift dates to the exact `https://mikek.ai` origin; tokens, payment amounts, employee notes, and credentials are never transferred. The hub accepts messages only from its own connection window at the exact House Manager origin. Keep that window open for live updates. Counts cover the latest 100 shifts/tasks and up to 100 employees.

Analytics covers the homepage only. Browser IDs expire after 30 days. Each page visit is deduplicated by a random ID. Cumulative beacons cannot decrease counts; maximum 50 tracked clicks and 30 minutes of active time per visit. Activity pauses for background tabs or after 60 seconds idle. Raw IP addresses and full referrer URLs are never stored. A hashed hourly network bucket limits traffic to 600 submissions/hour, plus a 12KB event limit and function maxInstances=3. This reduces abuse but cannot eliminate bots or client spoofing; counts are estimates. Do Not Track and Global Privacy Control opt out. Reports show at most the latest 10,000 visits within 90 days. No external conversion, location, or social-platform account data is claimed.

Firestore TTL policies on `hubVisits.expiresAt` (90 days) and `hubRate.expiresAt` (2 hours) are configured separately; expiry removal is asynchronous. Private activity collections are never publicly readable through this API. Debug logs and node_modules must not be committed.
