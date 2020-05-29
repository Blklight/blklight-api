"use strict";

/** @type {import('@adonisjs/lucid/src/Schema')} */
const Schema = use("Schema");

class AdministratorSchema extends Schema {
  up() {
    this.create("administrators", (table) => {
      table.increments();
      table.string("name", 150).notNullable().unique();
      table.text("email").notNullable().unique();
      table.text("password").notNullable();
      table.timestamps();
    });
  }

  down() {
    this.drop("administrators");
  }
}

module.exports = AdministratorSchema;
