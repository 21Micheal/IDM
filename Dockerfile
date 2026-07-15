# syntax=docker/dockerfile:1
# ──────────────────────────────────────────────────────────────────────────────
# Multi-stage build for the IDM Django app image (backend + every celery worker).
#
#   • builder  — has the compilers + *-dev headers needed to build the only two
#     packages without PyPI wheels (python-ldap, mysqlclient). Everything is
#     installed into an isolated venv at /opt/venv.
#   • runtime  — slim image with ONLY the runtime shared libs + the document
#     tooling (LibreOffice, Tesseract, Ghostscript, poppler). The venv is copied
#     in whole, so gcc/build-essential/*-dev (several hundred MB) never ship.
#
# Same python:3.10-slim-bookworm base in both stages → the venv is ABI-compatible.
# ──────────────────────────────────────────────────────────────────────────────

# ── Stage 1: build Python deps ────────────────────────────────────────────────
FROM python:3.10-slim-bookworm AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_ROOT_USER_ACTION=ignore \
    DEBIAN_FRONTEND=noninteractive

# Compile-time dependencies for the two source-only packages:
#   python-ldap → libldap2-dev, libsasl2-dev, libssl-dev
#   mysqlclient → default-libmysqlclient-dev, pkg-config
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libldap2-dev \
    libsasl2-dev \
    libssl-dev \
    default-libmysqlclient-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Build everything into an isolated venv so it can be copied to the runtime stage.
ENV VIRTUAL_ENV=/opt/venv
RUN python -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

COPY requirements.txt .
RUN python -m pip install --upgrade pip setuptools wheel \
    && python -m pip install -r requirements.txt

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM python:3.10-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore \
    DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# Runtime-only system packages: document tooling + the shared libs the compiled
# wheels link against (NO compilers, NO *-dev headers).
RUN apt-get update && apt-get install -y --no-install-recommends \
    # python-magic:
    libmagic1 \
    # OCR:
    tesseract-ocr \
    tesseract-ocr-eng \
    poppler-utils \
    # Ghostscript for deep PDF compression (PDF editor "Compress" job):
    ghostscript \
    # LibreOffice for Office document conversion:
    libreoffice \
    # Runtime shared libs for PaddleOCR/OpenCV:
    libgomp1 \
    libglib2.0-0 \
    libgl1 \
    # Runtime shared libs the source-built wheels link against:
    #   python-ldap → libldap-2.5-0 (ships liblber too), libsasl2-2
    #   mysqlclient → libmariadb3
    libldap-2.5-0 \
    libsasl2-2 \
    libmariadb3 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
# Note: for additional languages eg swahili, add tesseract-ocr-swa to the install list above

# Bring in the pre-built virtualenv (all Python deps + the spaCy en_core_web_sm
# model, which is a pip package). Activate it by putting it first on PATH.
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" \
    VIRTUAL_ENV=/opt/venv

# Pre-download PaddleOCR PP-OCRv4 models (~8 MB) so the first OCR job doesn't
# incur a download delay. Written to /root/.paddleocr; at runtime the compose
# volume (paddle_models:/root/.paddleocr) takes precedence and persists them.
RUN python -c "\
import cv2; \
from paddleocr import PaddleOCR; \
PaddleOCR(lang='en', use_angle_cls=True, use_gpu=False, show_log=False)"

# Verify the spaCy NER model is importable from the copied venv.
RUN python -c "import spacy; spacy.load('en_core_web_sm')"

# Fail fast if a runtime shared lib for a source-built wheel is missing — these
# two import names exercise mysqlclient (libmariadb3) and python-ldap
# (libldap-2.5-0 / libsasl2-2), the only deps compiled in the builder stage.
RUN python -c "import MySQLdb, ldap; print('native lib linkage OK')"

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 8000

# The default command is overridden by docker-compose for the different services.
CMD ["gunicorn", "IDM.wsgi:application", "--bind", "0.0.0.0:8000"]
