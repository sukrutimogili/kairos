#!/bin/bash
set -e

BASE_DIR="tests/fixtures/ecommerce-project/src/main/java/com/shop"

mkdir -p "$BASE_DIR/model"
mkdir -p "$BASE_DIR/repository"
mkdir -p "$BASE_DIR/service"
mkdir -p "$BASE_DIR/controller"

cat << 'JAVA' > "$BASE_DIR/model/User.java"
package com.shop.model;

public class User {
    private String id;
    private String email;

    public String getId() { return id; }
    public String getEmail() { return email; }
}
JAVA

cat << 'JAVA' > "$BASE_DIR/model/Payment.java"
package com.shop.model;

public class Payment {
    private String paymentId;
    private double amount;
    private String status;

    public String getPaymentId() { return paymentId; }
    public double getAmount() { return amount; }
    public String getStatus() { return status; }
}
JAVA

cat << 'JAVA' > "$BASE_DIR/model/Order.java"
package com.shop.model;

import com.shop.model.User;
import com.shop.model.Payment;

public class Order {
    private String orderId;
    private User user;
    private Payment payment;

    public String getOrderId() { return orderId; }
    public User getUser() { return user; }
    public Payment getPayment() { return payment; }
}
JAVA

cat << 'JAVA' > "$BASE_DIR/repository/UserRepository.java"
package com.shop.repository;

import com.shop.model.User;

public class UserRepository {
    public User findById(String id) {
        return new User();
    }
}
JAVA

cat << 'JAVA' > "$BASE_DIR/repository/PaymentRepository.java"
package com.shop.repository;

import com.shop.model.Payment;

public class PaymentRepository {
    public void save(Payment payment) {}
}
JAVA

cat << 'JAVA' > "$BASE_DIR/repository/OrderRepository.java"
package com.shop.repository;

import com.shop.model.Order;

public class OrderRepository {
    public void save(Order order) {}
}
JAVA

cat << 'JAVA' > "$BASE_DIR/service/NotificationService.java"
package com.shop.service;

import com.shop.model.User;

public class NotificationService {
    public void sendEmail(User user, String message) {}
}
JAVA

cat << 'JAVA' > "$BASE_DIR/service/PaymentService.java"
package com.shop.service;

import com.shop.model.Payment;
import com.shop.repository.PaymentRepository;

public class PaymentService {
    private PaymentRepository paymentRepository = new PaymentRepository();

    public Payment processPayment(double amount) {
        Payment p = new Payment();
        paymentRepository.save(p);
        return p;
    }
}
JAVA

cat << 'JAVA' > "$BASE_DIR/service/OrderService.java"
package com.shop.service;

import com.shop.model.Order;
import com.shop.model.User;
import com.shop.model.Payment;
import com.shop.repository.OrderRepository;
import com.shop.repository.UserRepository;
import com.shop.service.PaymentService;
import com.shop.service.NotificationService;

public class OrderService {
    private OrderRepository orderRepository = new OrderRepository();
    private UserRepository userRepository = new UserRepository();
    private PaymentService paymentService = new PaymentService();
    private NotificationService notificationService = new NotificationService();

    public Order placeOrder(String userId, double amount) {
        User user = userRepository.findById(userId);
        Payment payment = paymentService.processPayment(amount);
        Order order = new Order();
        orderRepository.save(order);
        notificationService.sendEmail(user, "Order confirmed!");
        return order;
    }
}
JAVA

cat << 'JAVA' > "$BASE_DIR/controller/OrderController.java"
package com.shop.controller;

import com.shop.service.OrderService;
import com.shop.model.Order;

public class OrderController {
    private OrderService orderService = new OrderService();

    public Order checkout(String userId, double amount) {
        return orderService.placeOrder(userId, amount);
    }
}
JAVA

echo "✅ Created 10 fixture files inside: $BASE_DIR"
