"""HTML sanitisation.

Document content is stored and rendered as HTML, so everything that reaches
the database (editor saves and file imports alike) passes through an
allow-list that matches what the editor can actually produce.
"""

from __future__ import annotations

import nh3

ALLOWED_TAGS = {
    "p", "br", "hr",
    "h1", "h2", "h3",
    "strong", "b", "em", "i", "u", "s",
    "ul", "ol", "li",
    "blockquote", "code", "pre",
    "a", "img",
}
ALLOWED_ATTRIBUTES = {
    "a": {"href", "target"},
    "ol": {"start"},
    "img": {"src", "alt", "title", "width", "height"},
}


def sanitize_html(html: str) -> str:
    return nh3.clean(
        html,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRIBUTES,
        url_schemes={"http", "https", "mailto", "data"},
        link_rel="noopener noreferrer nofollow",
    ).strip()
