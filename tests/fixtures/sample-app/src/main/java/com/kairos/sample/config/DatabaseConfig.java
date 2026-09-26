package com.kairos.sample.config;

import com.kairos.sample.util.Logger;

public class DatabaseConfig {
    private final String url = "jdbc:postgresql://localhost:5432/kairos_db";

    public void connect() {
        Logger.info("Connecting to database at: " + url);
    }
}
