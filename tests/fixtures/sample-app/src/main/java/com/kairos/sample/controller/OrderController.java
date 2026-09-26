package com.kairos.sample.controller;

import com.kairos.sample.service.OrderService;

public class OrderController {
    private final OrderService orderService = new OrderService();

    public String handleGetOrdersRequest(String userId) {
        return orderService.getUserOrders(userId);
    }
}
