package com.kairos.sample.repository;

import com.kairos.sample.config.DatabaseConfig;
import com.kairos.sample.util.Logger;

public class UserRepository {
    private final DatabaseConfig dbConfig = new DatabaseConfig();

    public String findUserById(String id) {
        dbConfig.connect();
        Logger.info("Executing DB Query for user: " + id);
        return "User_" + id;
    }
}
