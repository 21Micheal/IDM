FROM python:3.12-slim

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1

# Set work directory
WORKDIR /app

# Install system dependencies
# 1. build-essential, pkg-config, and default-libmysqlclient-dev are required for the mysqlclient header files.
# 2. libmagic1 is required by the 'python-magic' library used in your serializers for file type detection.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    default-libmysqlclient-dev \
    pkg-config \
    libmagic1 \
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