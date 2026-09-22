package com.example.service;

import com.example.repository.UserRepository;

public class UserService {
    private final UserRepository userRepository = new UserRepository();

    public String getUser(String id) {
        return userRepository.findById(id);
    }
}
