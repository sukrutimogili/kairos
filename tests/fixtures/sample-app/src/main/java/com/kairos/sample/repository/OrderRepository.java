package com.kairos.sample.repository;

import com.kairos.sample.config.DatabaseConfig;
import com.kairos.sample.util.Logger;

public class OrderRepository {
    private final DatabaseConfig dbConfig = new DatabaseConfig();

    public String findOrdersByUserId(String userId) {
        dbConfig.connect();
        Logger.info("Executing DB Query for orders of user: " + userId);
        return "Order_List_For_" + userId;
    }
}
