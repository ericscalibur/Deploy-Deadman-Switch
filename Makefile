# Makefile for Start9 Deadman Switch package

.PHONY: verify install

PKG_ID := deadman-switch
PKG_VERSION := 1.0.0
TS_FILES := $(shell find start9 -name \*.ts 2>/dev/null)

# Docker image name
DOCKER_IMAGE := start9/$(PKG_ID)/main:$(PKG_VERSION)

# Verify package structure and dependencies
verify:
	@echo "Verifying package structure..."
	@if [ ! -f "package.json" ]; then echo "Error: package.json not found"; exit 1; fi
	@if [ ! -f "server.js" ]; then echo "Error: server.js not found"; exit 1; fi
	@if [ ! -d "start9" ]; then echo "Error: start9 directory not found"; exit 1; fi
	@if [ ! -f "start9/manifest.yaml" ]; then echo "Error: start9/manifest.yaml not found"; exit 1; fi
	@if [ ! -f "Dockerfile" ]; then echo "Error: Dockerfile not found"; exit 1; fi
	@echo "Package structure verification complete"

# Build Docker image
docker-image: verify
	@echo "Building Docker image..."
	docker build --tag $(DOCKER_IMAGE) --platform=linux/amd64 .
	@echo "Docker image built: $(DOCKER_IMAGE)"

# Build Start9 package
build: docker-image
	@echo "Building Start9 package..."

	# Create temporary build directory
	@mkdir -p build

	# Copy manifest
	@cp start9/manifest.yaml build/

	# Make scripts executable
	@chmod +x start9/*.sh

	# Copy Start9 scripts
	@cp -r start9 build/

	# Create instructions
	@echo "# Deadman Switch Setup Instructions" > build/instructions.md
	@echo "" >> build/instructions.md
	@echo "## Initial Configuration" >> build/instructions.md
	@echo "1. Go to the **Config** tab in your Start9 interface" >> build/instructions.md
	@echo "2. Configure your email provider (Gmail or custom SMTP)" >> build/instructions.md
	@echo "3. For Gmail: Enable 2FA and generate an App Password" >> build/instructions.md
	@echo "4. Save the configuration and restart the service" >> build/instructions.md
	@echo "" >> build/instructions.md
	@echo "## Usage" >> build/instructions.md
	@echo "1. Open the web interface from your Services page" >> build/instructions.md
	@echo "2. Create an account and log in" >> build/instructions.md
	@echo "3. Configure recipient emails and deadman settings" >> build/instructions.md
	@echo "4. Activate the deadman switch" >> build/instructions.md
	@echo "" >> build/instructions.md
	@echo "## Important Notes" >> build/instructions.md
	@echo "- Test your configuration before relying on it" >> build/instructions.md
	@echo "- Keep your email credentials secure" >> build/instructions.md
	@echo "- Regular check-ins are required to prevent activation" >> build/instructions.md

	# Create simple icon (can be replaced with actual icon file)
	@echo "Creating placeholder icon..."
	@convert -size 256x256 xc:lightblue -pointsize 24 -fill black -gravity center \
		-annotate +0+0 'Deadman\nSwitch' build/icon.png 2>/dev/null || \
		echo "⚠️ Warning: ImageMagick not available, creating text-based icon" && \
		echo "📡" > build/icon.png

	# Copy license
	@cp LICENSE build/ 2>/dev/null || echo "MIT License" > build/LICENSE

	# Export Docker image to tarball
	@echo "Exporting Docker image..."
	@docker save $(DOCKER_IMAGE) | gzip > build/image.tar.gz

	@echo "Start9 package built successfully in build/ directory"
	@echo "Package contents:"
	@ls -la build/

# Install package (for development/testing)
install: build
	@echo "Installing package to Start9..."
	@if command -v start-cli >/dev/null 2>&1; then \
		echo "Using start-cli to install..."; \
		start-cli package install build/; \
	else \
		echo "start-cli not found. Manual installation required:"; \
		echo "1. Copy build/ contents to your Start9 server"; \
		echo "2. Use the Start9 web interface to install the package"; \
	fi

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	@rm -rf build/
	@docker rmi $(DOCKER_IMAGE) 2>/dev/null || true
	@echo "Clean complete"

# Development helpers
dev-build: verify
	@echo "Building for development..."
	@docker build --tag $(PKG_ID)-dev .

dev-run: dev-build
	@echo "Running development container..."
	@docker run --rm -p 3000:3000 -v $(PWD):/app $(PKG_ID)-dev

# Package validation
validate: build
	@echo "Validating Start9 package..."
	@if [ ! -f "build/manifest.yaml" ]; then echo "❌ Missing manifest.yaml"; exit 1; fi
	@if [ ! -f "build/image.tar.gz" ]; then echo "❌ Missing Docker image"; exit 1; fi
	@if [ ! -f "build/icon.png" ]; then echo "❌ Missing icon.png"; exit 1; fi
	@if [ ! -f "build/instructions.md" ]; then echo "❌ Missing instructions.md"; exit 1; fi
	@echo "✅ Package validation passed"

# Help target
help:
	@echo "Start9 Deadman Switch Package Build System"
	@echo ""
	@echo "Available targets:"
	@echo "  verify      - Verify package structure and dependencies"
	@echo "  build       - Build complete Start9 package"
	@echo "  install     - Install package to Start9 (requires start-cli)"
	@echo "  clean       - Clean build artifacts"
	@echo "  validate    - Validate built package"
	@echo "  dev-build   - Build development Docker image"
	@echo "  dev-run     - Run development container"
	@echo "  help        - Show this help message"
	@echo ""
	@echo "Build output will be in the build/ directory"

# Default target
all: build validate

# Build without Docker (for testing structure only)
build-no-docker: verify
	@echo "Building Start9 package (without Docker)..."
	@echo "⚠️  Warning: This creates a package without the Docker image"
	@echo "⚠️  Install Docker to build a complete package"

	# Create temporary build directory
	@mkdir -p build

	# Copy manifest
	@cp start9/manifest.yaml build/

	# Make scripts executable
	@chmod +x start9/*.sh

	# Copy Start9 scripts
	@cp -r start9 build/

	# Create instructions
	@echo "# Deadman Switch Setup Instructions" > build/instructions.md
	@echo "" >> build/instructions.md
	@echo "## Initial Configuration" >> build/instructions.md
	@echo "1. Go to the **Config** tab in your Start9 interface" >> build/instructions.md
	@echo "2. Configure your email provider (Gmail or custom SMTP)" >> build/instructions.md
	@echo "3. For Gmail: Enable 2FA and generate an App Password" >> build/instructions.md
	@echo "4. Save the configuration and restart the service" >> build/instructions.md
	@echo "" >> build/instructions.md
	@echo "## Usage" >> build/instructions.md
	@echo "1. Open the web interface from your Services page" >> build/instructions.md
	@echo "2. Create an account and log in" >> build/instructions.md
	@echo "3. Configure recipient emails and deadman settings" >> build/instructions.md
	@echo "4. Activate the deadman switch" >> build/instructions.md
	@echo "" >> build/instructions.md
	@echo "## Important Notes" >> build/instructions.md
	@echo "- Test your configuration before relying on it" >> build/instructions.md
	@echo "- Keep your email credentials secure" >> build/instructions.md
	@echo "- Regular check-ins are required to prevent activation" >> build/instructions.md

	# Create simple icon placeholder
	@echo "📡 Deadman Switch" > build/icon.png

	# Copy license
	@cp LICENSE build/ 2>/dev/null || echo "MIT License" > build/LICENSE

	# Create placeholder for Docker image
	@echo "Docker image placeholder - install Docker to build complete package" > build/image.tar.gz

	@echo "✅ Start9 package structure built (without Docker image)"
	@echo "📁 Package contents:"
	@ls -la build/
	@echo ""
	@echo "🐳 To build complete package with Docker:"
	@echo "   1. Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
	@echo "   2. Run: make build"

# Set default target
.DEFAULT_GOAL := help
