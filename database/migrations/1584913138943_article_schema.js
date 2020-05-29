"use strict";

/** @type {import('@adonisjs/lucid/src/Schema')} */
const Schema = use("Schema");

class ArticleSchema extends Schema {
  up() {
    this.create("articles", (table) => {
      table.increments();
      table.string("title", 255).notNullable();
      table.string("description", 500).nullable();
      table.text("slug").notNullable().unique();
      table.text("content").nullable();
      table.boolean("featured").nullable().defaultTo(0);
      table
        .integer("type_id")
        .unsigned()
        .references("id")
        .inTable("type")
        .notNullable()
        .defaultTo(1);
      table
        .boolean("status_id")
        .unsigned()
        .references("id")
        .inTable("status")
        .notNullable()
        .defaultTo(1);
      table
        .integer("channel_id")
        .unsigned()
        .references("id")
        .inTable("channels");
      table.integer("author_id").unsigned().references("id").inTable("users");
      table.timestamps();
    });
  }

  down() {
    this.drop("articles");
  }
}

module.exports = ArticleSchema;
