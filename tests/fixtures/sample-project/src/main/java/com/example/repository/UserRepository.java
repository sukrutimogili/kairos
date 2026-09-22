package com.example.repository;

public class UserRepository {
    public String findById(String id) {
        return "user-" + id;
    }
}
