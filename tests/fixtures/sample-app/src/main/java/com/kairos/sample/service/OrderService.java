package com.kairos.sample.service;

import com.kairos.sample.repository.OrderRepository;
import com.kairos.sample.util.Logger;

public class OrderService {
    private final OrderRepository orderRepository = new OrderRepository();

    public String getUserOrders(String userId) {
        Logger.info("OrderService fetching orders for " + userId);
        return orderRepository.findOrdersByUserId(userId);
    }
}
