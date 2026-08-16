FROM alpine:latest
WORKDIR /app
COPY pocketbase /app/pocketbase
RUN chmod +x /app/pocketbase
EXPOSE 8090
CMD ["/app/pocketbase", "serve", "--http=0.0.0.0:8090"]
