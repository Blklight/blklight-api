"use strict";

/*
|--------------------------------------------------------------------------
| RoleSeeder
|--------------------------------------------------------------------------
|
| Make use of the Factory instance to seed database with dummy data or
| make use of Lucid models directly.
|
*/

/** @type {import('@adonisjs/lucid/src/Factory')} */
const Factory = use("Factory");
const RoleModel = use("App/Models/Role");

class RoleSeeder {
  async run() {
    await RoleModel.create({
      role: "Administrador",
    });

    await RoleModel.create({
      role: "Usuário Comum",
    });
  }
}

module.exports = RoleSeeder;
