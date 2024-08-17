# Use the texlive/texlive image as the base image
FROM texlive/texlive:latest

# Set environment variables
ENV DEBIAN_FRONTEND=noninteractive
ENV VENV_PATH=/venv

# Install Python and dependencies
RUN apt-get update && \
    apt-get install -y python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

# Create and activate a Python virtual environment
RUN python3 -m venv $VENV_PATH

# Install Python dependencies
COPY requirements.txt /app/
RUN $VENV_PATH/bin/pip install --upgrade pip setuptools wheel && \
    $VENV_PATH/bin/pip install -r /app/requirements.txt

# Setup entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]