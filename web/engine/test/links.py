"""Print the link annotations of PDFs as JSON. Usage: python -I links.py <pdf>..."""

import json
import sys

from pypdf import PdfReader


def links(path):
    out = []
    for number, page in enumerate(PdfReader(path).pages, 1):
        for ref in page.get("/Annots") or []:
            annot = ref.get_object()
            if annot.get("/Subtype") != "/Link":
                continue
            action = annot.get("/A") or {}
            target = action.get("/URI") or action.get("/D") or annot.get("/Dest")
            rect = [round(float(x), 2) for x in annot["/Rect"]]
            out.append([number, str(target), rect])
    return out


print(json.dumps({p: links(p) for p in sys.argv[1:]}))
