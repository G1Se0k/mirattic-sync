# Wraps the jar from `./mvnw package`. No RUN step, so CI builds the arm64 image on an x64 runner
# without emulation.
FROM eclipse-temurin:21-jre
COPY target/server-0.0.1-SNAPSHOT.jar /app.jar
USER 65534
EXPOSE 8080
# 60%: non-heap needs ~0.9 GB under load (threads, buffers), which 25% of compose's mem_limit would not leave.
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=60", "-jar", "/app.jar"]
