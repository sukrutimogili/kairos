package com.kairos.sample;

import com.kairos.sample.controller.UserController;
import com.kairos.sample.controller.OrderController;
import com.kairos.sample.util.Logger;

public class Main {
    public static void main(String[] args) {
        UserController userController = new UserController();
        OrderController orderController = new OrderController();

        String user = userController.handleGetUserRequest("101");
        String orders = orderController.handleGetOrdersRequest("101");

        Logger.info("App initialized with user: " + user + " and orders: " + orders);
    }
}
