# Use the same base image as before
FROM mcr.microsoft.com/devcontainers/go:1

# Install Git LFS
RUN apt-get update && apt-get install -y git-lfs && \
    git lfs install && \
    rm -rf /var/lib/apt/lists/*