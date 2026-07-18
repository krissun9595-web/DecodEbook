import time, pymupdf4llm
FILE = "/root/testfiles/Agentic Mesh The GenAI-Powered Autonomous Agent Ecosystem.pdf"
for pg,label in {34:"p35 McKinsey (hyphen 'estimates' + numbers)", 5:"p6 colophon (row-major)", 39:"p40 prose+bullets"}.items():
    md = pymupdf4llm.to_markdown(FILE, pages=[pg], show_progress=False).strip()
    print(f"\n{'='*66}\n{label}\n{'='*66}")
    print(md[:900])
    print("  ...[checks]", "estimates✓" if "estimates" in md else "esti-✗",
          "| 3,800✓" if "3,800" in md else "3,800✗",
          "| 7,000✓" if "7,000" in md else "7,000✗")
# whole-book timing
import pymupdf
n = pymupdf.open(FILE).page_count
t=time.time(); _ = pymupdf4llm.to_markdown(FILE, show_progress=False); dt=time.time()-t
print(f"\n[WHOLE BOOK: {n} pages in {dt:.1f}s  = {dt/n*1000:.0f}ms/page]")
