FROM texlive/texlive:latest

ENV DEBIAN_FRONTEND=noninteractive
ENV VENV_PATH=/venv

# Fix DNS or HTTP-related fetch issues first
RUN find /etc/apt/sources.list.d -name "*.list" -exec sed -i 's|http://deb.debian.org|https://deb.debian.org|g' {} + && \
    apt-get update && \
    apt-get install -y curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install Python
RUN apt-get update && \
    apt-get install -y python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

# Create virtual environment
RUN python3 -m venv $VENV_PATH

# Install Python packages
COPY requirements.txt /app/
RUN $VENV_PATH/bin/pip install --upgrade pip setuptools wheel && \
    $VENV_PATH/bin/pip install -r /app/requirements.txt

# Setup entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]