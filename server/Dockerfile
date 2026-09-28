# Wraps the jar from `./mvnw package`. No RUN step, so CI builds the arm64 image on an x64 runner
# without emulation.
FROM eclipse-temurin:21-jre
COPY target/server-0.0.1-SNAPSHOT.jar /app.jar
USER 65534
EXPOSE 8080
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app.jar"]
