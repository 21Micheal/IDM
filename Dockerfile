FROM python:3.12-slim

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1

# Set work directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    python3-dev \
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
    # for additional languages eg swahili, add tesseract-ocr-swa
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
# Using a separate step for requirements allows Docker to cache this layer
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 8000

# The default command is overridden by docker-compose.yml for different services
CMD ["gunicorn", "IDM.wsgi:application", "--bind", "0.0.0.0:8000"]