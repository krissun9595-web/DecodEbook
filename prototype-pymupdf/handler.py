"""
Serverless extraction handler (prototype) — PyMuPDF4LLM.
Deploy target: a Python runtime (Cloud Run / AWS Lambda container / Fly.io) — NOT Cloudflare
Workers (JS/WASM only; PyMuPDF is native). Called at UPLOAD time; returns structured blocks the
app maps into its content format. Isolated from the app — nothing here imports app code.
"""
import pymupdf4llm

def extract(pdf_path: str) -> dict:
    # ocr=False keeps it fast (skip Tesseract on image pages); page_chunks gives per-page structure.
    chunks = pymupdf4llm.to_markdown(pdf_path, page_chunks=True, show_progress=False)
    pages = [{"page": i + 1, "markdown": c["text"]} for i, c in enumerate(chunks)]
    return {"pages": pages}

# def lambda_handler(event, context):  # or FastAPI POST /extract with the uploaded PDF bytes
#     return extract(save_tmp(event["body"]))
