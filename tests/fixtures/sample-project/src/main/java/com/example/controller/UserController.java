package com.example.controller;

import com.example.service.UserService;

public class UserController {
    private final UserService userService = new UserService();

    public String handleGetUser(String id) {
        return userService.getUser(id);
    }
}
