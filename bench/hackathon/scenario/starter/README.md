# Booking hackathon

Build a working small appointment-booking application. Run with `npm start` on
`PORT` (default 3000); persist bookings at `DB_PATH` (default `.data/bookings.sqlite`).
No dependencies are required: Node includes HTTP and SQLite support.

## Acceptance requirements

- Serve the booking page at `/`, its module at `/app.js`, and its API client at `/api.mjs`.
- `GET /api/slots` returns `{slots:[{slotId,label,available}]}`. Seed slots `s1`
  (09:00), `s2` (10:00), and `s3` (11:00). IDs and availability must be stable.
- `POST /api/bookings` accepts `{slotId,name}`, returns 201 with `{booking:{id,slotId,name}}`.
- Empty/whitespace names, unknown slots, and malformed JSON return 400 JSON errors.
- Booking an unavailable slot returns 409. Concurrent attempts must not double-book.
- `GET /api/bookings` returns `{bookings:[...]}`. Bookings survive a server restart,
  in a real SQLite database. Availability updates after a booking and after restart.
- The page has a slot selector `#slot`, a name input `#name`, a form `#booking-form`,
  and a message area `#message`. It loads slots, submits bookings, displays success
  or errors, and refreshes availability. Preserve these selectors for automation.
- `public/api.mjs` exports `loadSlots()` returning the slots array and
  `createBooking(slotId,name)` returning a booking. It uses browser-relative fetch
  URLs, sends JSON, and rejects with useful errors on non-2xx responses.
- Frontend, HTTP API, and storage must actually connect; hardcoded responses do
  not meet the requirements. Keep public exports and command-line entry points.

The initial code is deliberately incomplete. The frontend expects camelCase IDs,
the old HTTP stub emits snake_case, and storage is currently memory-only. Coordinate
contract changes and adapter work. This is a small integration task, not a redesign.

## Collaboration

Each participant owns a separate directory. Use normal Git branches, commits,
fetches, merges/rebases, GitHub issues/comments/PRs, or any supplied Patchwork tools.
Integrate into `main` yourselves, without force pushes. No runner will merge for you.
Review peers' work and resolve conflicts together. Do not touch other repositories,
credentials, simulator configuration, grading machinery, or the scenario marker.
No GitHub Actions, external services, package installs, or long polling/sleep loops.

The final remote `main` is graded against the requirements above. Tests outside the
workspaces exercise HTTP, persistence, and the frontend API client; UI selectors
are smoke-tested, not a complete browser usability assessment.
