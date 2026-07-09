# Frontend

`frontend/` is the browser UI for Elastisched (vanilla HTML/CSS/JS).

## Structure
- [`frontend/index.html`](index.html): app shell and modal/layout markup.
- [`frontend/css/styles.css`](css/styles.css): visual theme and layout styles.
- [`frontend/js/app.js`](js/app.js): app bootstrap + workspace behavior.
- [`frontend/js/api.js`](js/api.js): API client calls (`/occurrences`, `/schedule`, `/recurrences`).
- [`frontend/js/render.js`](js/render.js): calendar/task rendering logic.
- [`frontend/js/forms.js`](js/forms.js): create/edit/settings form handling.

## Serving
- From backend static mount: `http://localhost:8000/ui`
- Or directly with a static web server from `frontend/`.
