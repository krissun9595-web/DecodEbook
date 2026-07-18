import time, pymupdf4llm, pymupdf
FILE = "/root/testfiles/Agentic Mesh The GenAI-Powered Autonomous Agent Ecosystem.pdf"
def md1(pg): return pymupdf4llm.to_markdown(FILE, pages=[pg], show_progress=False).strip()
for pg,label in {34:"p35 McKinsey", 5:"p6 colophon", 39:"p40 prose+bullets"}.items():
    md = md1(pg)
    print(f"\n{'='*60}\n{label}\n{'='*60}", flush=True)
    print(md[:820], flush=True)
    print("  CHECKS:", "estimates✓" if "estimates" in md else "esti‐✗",
          "| 3,800✓" if "3,800" in md else "3,800✗", "| 7,000✓" if "7,000" in md else "7,000✗", flush=True)
# timing sample: 25 body pages (text-heavy), warm
t=time.time()
for pg in range(30,55): pymupdf4llm.to_markdown(FILE, pages=[pg], show_progress=False)
dt=time.time()-t
print(f"\n[TIMING] 25 body pages in {dt:.1f}s = {dt/25*1000:.0f}ms/page → ~{dt/25*pymupdf.open(FILE).page_count:.0f}s for {pymupdf.open(FILE).page_count} pages", flush=True)
