FROM python:3.10-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_ROOT_USER_ACTION=ignore \
    DEBIAN_FRONTEND=noninteractive

# Set work directory
WORKDIR /app

# Install system dependencies in one layer so compiled Python packages and
# runtime tools (OCR, PDF conversion, LibreOffice previews) see the same libs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    # Dependencies for python-ldap:
    libldap2-dev \
    libsasl2-dev \
    libssl-dev \
    # Dependencies for mysqlclient:
    default-libmysqlclient-dev \
    pkg-config \
    # Dependency for python-magic:
    libmagic1 \
    # Dependencies for OCR:
    tesseract-ocr \
    tesseract-ocr-eng \
    poppler-utils \
    # Ghostscript for deep PDF compression (PDF editor "Compress" job):
    ghostscript \
    # LibreOffice for Office document conversion:
    libreoffice \
    # Runtime dependencies for PaddleOCR/OpenCV:
    libgomp1 \
    libglib2.0-0 \
    libgl1 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
# Note: for additional languages eg swahili, add tesseract-ocr-swa to the install list above

# Install Python dependencies
# Using a separate step for requirements allows Docker to cache this layer
COPY requirements.txt .
RUN python -m pip install --upgrade pip setuptools wheel \
    && python -m pip install -r requirements.txt

# Pre-download PaddleOCR PP-OCRv4 models (~8 MB total)
#    This runs at build time so the first OCR job doesn't incur a download delay.
#    Models are written to /root/.paddleocr inside the image;
#    the docker-compose volume mount (paddle_models:/root/.paddleocr) takes
#    precedence at runtime to persist models between rebuilds.
RUN python -c "\
import cv2; \
from paddleocr import PaddleOCR; \
PaddleOCR(lang='en', use_angle_cls=True, use_gpu=False, show_log=False)"

# Verify the spaCy NER model installed from requirements.txt.
RUN python -c "import spacy; spacy.load('en_core_web_sm')"

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 8000

# The default command is overridden by docker-compose.yml for different services
CMD ["gunicorn", "IDM.wsgi:application", "--bind", "0.0.0.0:8000"]
