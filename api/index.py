"""Vercel Python entrypoint.

Vercel turns every module in /api into a serverless function and serves the
WSGI `app` it exports. Locally, `npm run dev` runs this same file with
`flask --app api/index run -p 5328` and Next.js proxies /api/* to it.
The application code lives in /server so it isn't exposed as extra functions.
"""

import os
import sys
from server import create_app  # noqa: E402

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
app = create_app()
