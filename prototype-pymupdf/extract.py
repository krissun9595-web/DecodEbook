import sys, pymupdf4llm, pymupdf
FILE = "/root/testfiles/Agentic Mesh The GenAI-Powered Autonomous Agent Ecosystem.pdf"
# 0-indexed pages: p2=1 (two-column back cover), p35=34 (McKinsey para), p40=39 (prose), p6=5 (colophon)
targets = {1: "p2 back-cover TWO-COLUMN", 34: "p35 McKinsey paragraph", 39: "p40 prose", 5: "p6 colophon"}
for pg, label in targets.items():
    md = pymupdf4llm.to_markdown(FILE, pages=[pg], show_progress=False)
    print(f"\n{'='*70}\n{label} (page index {pg})\n{'='*70}")
    print(md.strip()[:1400])
