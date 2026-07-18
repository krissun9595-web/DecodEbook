import time, pymupdf4llm
FILE = "/root/testfiles/Agentic Mesh The GenAI-Powered Autonomous Agent Ecosystem.pdf"
t=time.time(); md = pymupdf4llm.to_markdown(FILE, pages=[1], show_progress=False); dt=time.time()-t
print(f"[p2 full — {dt*1000:.0f}ms]\n")
print(md.strip())
