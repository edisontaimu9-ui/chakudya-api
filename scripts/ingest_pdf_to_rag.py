#!/usr/bin/env python3
"""
Ingest a PDF into the Chakudya RAG knowledge base (POST /rag/ingest).

Extracts text page-by-page (pypdf — pure Python, no native compile step,
which matters on Termux/ARM64), splits each page into ~150-220 word
chunks along paragraph boundaries, and POSTs each chunk with page-level
metadata so retrieval results can cite exactly where they came from.

Usage:
    export CHAKUDYA_ADMIN_KEY="your-admin-key"
    python3 ingest_pdf_to_rag.py <path-to.pdf> \
        --source "Krause & Mahan's Food and the Nutrition Care Process, 16th Ed. (pp. 1131-1168)" \
        --context both \
        --start-page 1131

Dry run first (no network calls, just shows what would be sent):
    python3 ingest_pdf_to_rag.py <path-to.pdf> --source "..." --dry-run
"""

import argparse
import os
import sys
import time

try:
    from pypdf import PdfReader
except ImportError:
    sys.exit("Missing dependency. Run: pip install pypdf requests --break-system-packages")

try:
    import requests
except ImportError:
    sys.exit("Missing dependency. Run: pip install pypdf requests --break-system-packages")

DEFAULT_BASE_URL = "https://chakudya-api.edisontaimu9.workers.dev"
MIN_CHUNK_WORDS = 60
TARGET_CHUNK_WORDS = 180
MAX_CHUNK_WORDS = 260


def split_page_into_chunks(page_text):
    """Greedily group paragraphs into ~TARGET_CHUNK_WORDS-sized chunks."""
    paragraphs = [p.strip() for p in page_text.split("\n\n") if p.strip()]
    if not paragraphs:
        # Fall back to line-based splitting if the PDF has no blank-line
        # paragraph breaks (common in scanned/columnar textbook layouts).
        paragraphs = [p.strip() for p in page_text.split("\n") if p.strip()]

    chunks = []
    current = []
    current_words = 0

    for para in paragraphs:
        para_words = len(para.split())
        if current_words + para_words > MAX_CHUNK_WORDS and current_words >= MIN_CHUNK_WORDS:
            chunks.append(" ".join(current))
            current = [para]
            current_words = para_words
        else:
            current.append(para)
            current_words += para_words
        if current_words >= TARGET_CHUNK_WORDS:
            chunks.append(" ".join(current))
            current = []
            current_words = 0

    if current:
        chunks.append(" ".join(current))

    return chunks


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf_path", help="Path to the PDF file")
    ap.add_argument("--source", required=True, help="Citation string stored on every chunk's 'source' field")
    ap.add_argument("--context", default="both", choices=["clinical", "general", "both"])
    ap.add_argument("--start-page", type=int, default=1, help="Real-world page number of the PDF's first page (for accurate metadata)")
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL)
    ap.add_argument("--dry-run", action="store_true", help="Preview chunks without calling the API")
    ap.add_argument("--sleep", type=float, default=0.3, help="Seconds to sleep between ingest calls (politeness delay)")
    args = ap.parse_args()

    admin_key = os.environ.get("CHAKUDYA_ADMIN_KEY")
    if not args.dry_run and not admin_key:
        sys.exit("Set CHAKUDYA_ADMIN_KEY env var first: export CHAKUDYA_ADMIN_KEY=\"your-admin-key\"")

    if not os.path.isfile(args.pdf_path):
        sys.exit(f"File not found: {args.pdf_path}")

    print(f"Reading {args.pdf_path} ...")
    reader = PdfReader(args.pdf_path)
    total_pages = len(reader.pages)
    print(f"{total_pages} pages found. Real-world page numbers: {args.start_page}-{args.start_page + total_pages - 1}")

    all_chunks = []  # list of (real_page_number, chunk_text)
    for i, page in enumerate(reader.pages):
        text = page.extract_text() or ""
        if not text.strip():
            continue
        real_page = args.start_page + i
        for chunk in split_page_into_chunks(text):
            if len(chunk.split()) >= MIN_CHUNK_WORDS // 2:  # skip near-empty scraps
                all_chunks.append((real_page, chunk))

    print(f"Built {len(all_chunks)} chunks.\n")

    if args.dry_run:
        preview_n = min(3, len(all_chunks))
        print(f"--dry-run: showing first {preview_n} chunk(s), no API calls made.\n")
        for page_num, chunk in all_chunks[:preview_n]:
            print(f"--- page {page_num} ({len(chunk.split())} words) ---")
            print(chunk[:300] + ("..." if len(chunk) > 300 else ""))
            print()
        print(f"Total chunks that WOULD be ingested: {len(all_chunks)}")
        return

    endpoint = f"{args.base_url.rstrip('/')}/rag/ingest"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {admin_key}",
    }

    ok_count = 0
    fail_count = 0
    for idx, (page_num, chunk) in enumerate(all_chunks, 1):
        payload = {
            "content": chunk,
            "source": args.source,
            "context": args.context,
            "metadata": {"page": page_num},
        }
        try:
            resp = requests.post(endpoint, json=payload, headers=headers, timeout=30)
            if resp.status_code == 200:
                ok_count += 1
                print(f"[{idx}/{len(all_chunks)}] page {page_num} -> OK")
            else:
                fail_count += 1
                print(f"[{idx}/{len(all_chunks)}] page {page_num} -> FAILED ({resp.status_code}): {resp.text[:200]}")
        except requests.RequestException as e:
            fail_count += 1
            print(f"[{idx}/{len(all_chunks)}] page {page_num} -> ERROR: {e}")

        time.sleep(args.sleep)

    print(f"\nDone. {ok_count} ingested, {fail_count} failed out of {len(all_chunks)} total.")
    if fail_count:
        sys.exit(1)


if __name__ == "__main__":
    main()
