#!/bin/bash
# Docker Compose health check and utility script for ChronoPay Backend
# Usage: ./scripts/docker-health.sh [command]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-chronopay-backend}
API_CONTAINER_NAME=${API_CONTAINER_NAME:-chronopay-api}
HEALTH_ENDPOINT="http://localhost:3001/health"
MAX_RETRIES=30
RETRY_INTERVAL=2

# Helper functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if Docker is running
check_docker() {
    if ! docker info >/dev/null 2>&1; then
        log_error "Docker is not running. Please start Docker and try again."
        exit 1
    fi
    log_info "Docker is running"
}

# Check if docker-compose is available
check_compose() {
    if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
        log_error "docker-compose is not installed. Please install it and try again."
        exit 1
    fi
    log_info "Docker Compose is available"
}

# Get the appropriate compose command
get_compose_cmd() {
    if command -v docker-compose &> /dev/null; then
        echo "docker-compose"
    else
        echo "docker compose"
    fi
}

# Wait for services to be healthy
wait_for_health() {
    log_info "Waiting for services to be healthy..."
    local retries=0
    
    while [ $retries -lt $MAX_RETRIES ]; do
        if curl -s "$HEALTH_ENDPOINT" | grep -q '"status":"ok"'; then
            log_info "Service is healthy!"
            return 0
        fi
        
        retries=$((retries + 1))
        log_warn "Health check failed (attempt $retries/$MAX_RETRIES). Retrying in ${RETRY_INTERVAL}s..."
        sleep $RETRY_INTERVAL
    done
    
    log_error "Service failed to become healthy after $MAX_RETRIES attempts"
    return 1
}

# Check container health
check_container_health() {
    local container_name=$1
    local health_status
    
    health_status=$(docker inspect --format='{{.State.Health.Status}}' "$container_name" 2>/dev/null || echo "none")
    
    if [ "$health_status" = "healthy" ]; then
        log_info "Container $container_name is healthy"
        return 0
    elif [ "$health_status" = "starting" ]; then
        log_warn "Container $container_name is starting..."
        return 1
    elif [ "$health_status" = "unhealthy" ]; then
        log_error "Container $container_name is unhealthy"
        return 1
    else
        log_warn "Container $container_name has no health check configured"
        return 1
    fi
}

# Start services
start_services() {
    log_info "Starting ChronoPay Backend services..."
    check_docker
    check_compose
    
    local compose_cmd
    compose_cmd=$(get_compose_cmd)
    
    # Check if .env file exists
    if [ ! -f ".env" ]; then
        log_warn ".env file not found. Creating from .env.example..."
        if [ -f ".env.example" ]; then
            cp .env.example .env
            log_info "Created .env from .env.example"
            log_warn "Please review and update .env with your configuration"
        else
            log_error ".env.example not found. Cannot create .env file."
            exit 1
        fi
    fi
    
    # Start services
    $compose_cmd up -d --build
    
    # Wait for health
    if wait_for_health; then
        log_info "ChronoPay Backend is running at http://localhost:3001"
        log_info "API Documentation available at http://localhost:3001/api-docs"
    else
        log_error "Failed to start services properly"
        show_logs
        exit 1
    fi
}

# Stop services
stop_services() {
    log_info "Stopping ChronoPay Backend services..."
    local compose_cmd
    compose_cmd=$(get_compose_cmd)
    $compose_cmd down
    log_info "Services stopped"
}

# Restart services
restart_services() {
    log_info "Restarting ChronoPay Backend services..."
    stop_services
    start_services
}

# Show logs
show_logs() {
    log_info "Showing service logs..."
    local compose_cmd
    compose_cmd=$(get_compose_cmd)
    $compose_cmd logs -f
}

# Show status
show_status() {
    log_info "Checking service status..."
    
    local compose_cmd
    compose_cmd=$(get_compose_cmd)
    
    echo ""
    echo "=== Container Status ==="
    $compose_cmd ps
    
    echo ""
    echo "=== Container Health ==="
    check_container_health "$API_CONTAINER_NAME" || true
    
    echo ""
    echo "=== Service Health Check ==="
    if curl -s "$HEALTH_ENDPOINT" | grep -q '"status":"ok"'; then
        log_info "API health check: OK"
        curl -s "$HEALTH_ENDPOINT" | head -1
    else
        log_error "API health check: FAILED"
    fi
}

# Run tests in container
run_tests() {
    log_info "Running tests in container..."
    local compose_cmd
    compose_cmd=$(get_compose_cmd)
    $compose_cmd exec api npm test
}

# Clean up
clean_up() {
    log_warn "This will remove all containers, volumes, and images. Are you sure? (y/N)"
    read -r response
    if [[ "$response" =~ ^[Yy]$ ]]; then
        local compose_cmd
        compose_cmd=$(get_compose_cmd)
        $compose_cmd down -v --rmi local
        log_info "Cleanup completed"
    else
        log_info "Cleanup cancelled"
    fi
}

# Main command handler
case "${1:-status}" in
    start|up)
        start_services
        ;;
    stop|down)
        stop_services
        ;;
    restart)
        restart_services
        ;;
    logs)
        show_logs
        ;;
    status)
        show_status
        ;;
    test)
        run_tests
        ;;
    health)
        check_docker
        check_compose
        if wait_for_health; then
            exit 0
        else
            exit 1
        fi
        ;;
    clean)
        clean_up
        ;;
    *)
        echo "Usage: $0 [command]"
        echo ""
        echo "Commands:"
        echo "  start    - Start all services"
        echo "  stop     - Stop all services"
        echo "  restart  - Restart all services"
        echo "  logs     - Show service logs"
        echo "  status   - Show service status (default)"
        echo "  test     - Run tests in container"
        echo "  health   - Check service health"
        echo "  clean    - Clean up containers, volumes, and images"
        echo ""
        exit 1
        ;;
esac
