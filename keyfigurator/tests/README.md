# tests/

Frontend checks that drive the built app in a real browser.

The app runs here in **browser mode** (`hasTauri === false`), so `invoke` goes to
`browserMock` in `main.js` rather than to Rust. That is the point: it exercises
the UI without a board, a bot token, or a network — the same bargain `MockHid`
makes for the editor.

```
npm run build
npx vite preview --port 5199        # in one terminal
node tests/chat-ui.mjs http://localhost:5199/
```

Every line prints `PASS` or `FAIL`; a non-empty `PAGE ERRORS` section at the end
means something threw that the assertions did not catch.

## Why these live in the repo

The rest of this project's Playwright suites were written into a scratchpad and
are not version-controlled, which is an open item in the `config-app` backlog.
New ones land here instead.
